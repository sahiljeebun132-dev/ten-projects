"""Held-out test evaluation: metrics, cost-sensitive threshold analysis, figures.

Run:  python -m src.evaluate            (or `make evaluate`)

Everything here reads the persisted pipeline; the test split is touched for the
first and only time in this module.
"""
from __future__ import annotations

import argparse
import json
import warnings
from pathlib import Path

import joblib
import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import seaborn as sns  # noqa: E402
from sklearn.calibration import calibration_curve  # noqa: E402
from sklearn.inspection import permutation_importance  # noqa: E402
from sklearn.metrics import (  # noqa: E402
    accuracy_score,
    average_precision_score,
    brier_score_loss,
    classification_report,
    confusion_matrix,
    f1_score,
    log_loss,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)
from sklearn.model_selection import learning_curve  # noqa: E402

from . import config  # noqa: E402
from .data import make_splits  # noqa: E402
from .features import get_feature_names  # noqa: E402
from .train import expected_value, threshold_sweep  # noqa: E402

sns.set_theme(style="whitegrid", palette=config.PALETTE)

try:  # SHAP is optional; we degrade to permutation importance if it misbehaves.
    import shap

    SHAP_AVAILABLE = True
except Exception:  # pragma: no cover
    shap = None
    SHAP_AVAILABLE = False


# --------------------------------------------------------------------------- #
def _save(fig: plt.Figure, name: str) -> Path:
    path = config.FIGURE_DIR / name
    fig.tight_layout()
    fig.savefig(path, dpi=config.FIG_DPI, bbox_inches="tight")
    plt.close(fig)
    print(f"  figure -> {path.relative_to(config.PROJECT_ROOT)}")
    return path


def load_artifacts():
    if not config.MODEL_PATH.exists():
        raise FileNotFoundError(
            f"{config.MODEL_PATH} not found - run `make train` first."
        )
    pipeline = joblib.load(config.MODEL_PATH)
    metadata = json.loads(config.METADATA_PATH.read_text())
    return pipeline, metadata


# --------------------------------------------------------------------------- #
# figures
# --------------------------------------------------------------------------- #
def plot_roc(y, p, auc: float) -> None:
    fpr, tpr, _ = roc_curve(y, p)
    fig, ax = plt.subplots(figsize=config.FIG_SIZE)
    ax.plot(fpr, tpr, lw=2, label=f"model (AUC = {auc:.3f})")
    ax.plot([0, 1], [0, 1], "k--", lw=1, label="chance (AUC = 0.500)")
    ax.set_xlabel("False positive rate")
    ax.set_ylabel("True positive rate")
    ax.set_title("ROC curve - held-out test set")
    ax.legend(loc="lower right")
    _save(fig, "roc_curve.png")


def plot_pr(y, p, ap: float, threshold: float) -> None:
    prec, rec, thr = precision_recall_curve(y, p)
    base = float(np.mean(y))
    fig, ax = plt.subplots(figsize=config.FIG_SIZE)
    ax.plot(rec, prec, lw=2, label=f"model (PR-AUC = {ap:.3f})")
    ax.axhline(base, ls="--", c="k", lw=1, label=f"prevalence = {base:.3f}")
    idx = int(np.searchsorted(thr, threshold))
    idx = min(idx, len(prec) - 1)
    ax.scatter([rec[idx]], [prec[idx]], s=70, zorder=5, color="crimson",
               label=f"operating point (t = {threshold:.2f})")
    ax.set_xlabel("Recall")
    ax.set_ylabel("Precision")
    ax.set_title("Precision-Recall curve - held-out test set")
    ax.legend(loc="upper right")
    _save(fig, "pr_curve.png")


def plot_confusion(cm: np.ndarray, threshold: float) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.4))
    labels = ["stay", "churn"]
    sns.heatmap(cm, annot=True, fmt="d", cmap="Blues", cbar=False,
                xticklabels=labels, yticklabels=labels, ax=axes[0])
    axes[0].set_title(f"Counts (threshold = {threshold:.2f})")
    norm = cm / cm.sum(axis=1, keepdims=True)
    sns.heatmap(norm, annot=True, fmt=".2%", cmap="Blues", cbar=False,
                xticklabels=labels, yticklabels=labels, ax=axes[1])
    axes[1].set_title("Row-normalised (recall per class)")
    for ax in axes:
        ax.set_xlabel("Predicted")
        ax.set_ylabel("Actual")
    fig.suptitle("Confusion matrix - held-out test set")
    _save(fig, "confusion_matrix.png")


def plot_calibration(y, p, brier: float) -> None:
    frac_pos, mean_pred = calibration_curve(y, p, n_bins=12, strategy="quantile")
    fig, (ax, ax2) = plt.subplots(
        2, 1, figsize=(7.5, 6.6), sharex=True,
        gridspec_kw={"height_ratios": [3, 1]},
    )
    ax.plot([0, 1], [0, 1], "k--", lw=1, label="perfectly calibrated")
    ax.plot(mean_pred, frac_pos, "o-", lw=2, label=f"model (Brier = {brier:.4f})")
    ax.set_ylabel("Observed churn rate")
    ax.set_title("Calibration curve (12 quantile bins) - held-out test set")
    ax.legend(loc="upper left")
    ax2.hist(p, bins=40, color="steelblue")
    ax2.set_xlabel("Predicted probability")
    ax2.set_ylabel("Count")
    _save(fig, "calibration_curve.png")


def plot_threshold_sweep(sweep: pd.DataFrame, chosen: float) -> None:
    fig, ax = plt.subplots(figsize=(8.5, 5.2))
    ax.plot(sweep.threshold, sweep.precision, label="precision")
    ax.plot(sweep.threshold, sweep.recall, label="recall")
    ax.plot(sweep.threshold, sweep.f1, label="F1")
    ax.plot(sweep.threshold, sweep.contact_rate, label="contact rate", ls=":")
    ax.axvline(chosen, color="crimson", ls="--",
               label=f"chosen threshold = {chosen:.2f}")
    ax.axvline(config.BREAK_EVEN_THRESHOLD, color="green", ls="-.", alpha=0.7,
               label=f"analytical break-even = {config.BREAK_EVEN_THRESHOLD:.3f}")
    ax.set_xlabel("Decision threshold")
    ax.set_ylabel("Metric value")

    ax2 = ax.twinx()
    ax2.plot(sweep.threshold, sweep.ev_per_customer, color="black", lw=2.2,
             label="expected value / customer")
    ax2.set_ylabel("Expected value per customer (currency units)")
    ax2.grid(False)

    h1, l1 = ax.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax.legend(h1 + h2, l1 + l2, loc="upper right", fontsize=8)
    ax.set_title("Threshold sweep on the test set: metrics and expected value")
    _save(fig, "threshold_sweep.png")


def plot_learning_curve(pipeline, X, y) -> None:
    from sklearn.base import clone
    from sklearn.model_selection import StratifiedKFold

    sizes = np.linspace(0.2, 1.0, 5)
    cv = StratifiedKFold(n_splits=3, shuffle=True, random_state=config.RANDOM_SEED)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        train_sizes, train_scores, val_scores = learning_curve(
            clone(pipeline), X, y, train_sizes=sizes, cv=cv, scoring="roc_auc",
            n_jobs=1, random_state=config.RANDOM_SEED, shuffle=True,
        )
    fig, ax = plt.subplots(figsize=config.FIG_SIZE)
    for scores, label, colour in (
        (train_scores, "training folds", "tab:blue"),
        (val_scores, "cross-validation folds", "tab:orange"),
    ):
        mean, std = scores.mean(axis=1), scores.std(axis=1)
        ax.plot(train_sizes, mean, "o-", color=colour, label=label)
        ax.fill_between(train_sizes, mean - std, mean + std, alpha=0.15, color=colour)
    ax.set_xlabel("Training examples")
    ax.set_ylabel("ROC-AUC")
    ax.set_title("Learning curve (3-fold CV on train+val)")
    ax.legend(loc="lower right")
    _save(fig, "learning_curve.png")


def plot_permutation_importance(pipeline, X, y, top_n: int = 20) -> pd.DataFrame:
    """Permutation importance on the *raw* input columns (pipeline-level)."""
    result = permutation_importance(
        pipeline, X, y, scoring="roc_auc", n_repeats=8,
        random_state=config.RANDOM_SEED, n_jobs=1,
    )
    imp = (
        pd.DataFrame(
            {
                "feature": list(X.columns),
                "importance_mean": result.importances_mean,
                "importance_std": result.importances_std,
            }
        )
        .sort_values("importance_mean", ascending=False)
        .reset_index(drop=True)
    )
    imp.to_csv(config.REPORT_DIR / "permutation_importance.csv", index=False)

    top = imp.head(top_n).iloc[::-1]
    fig, ax = plt.subplots(figsize=(8, 6))
    ax.barh(top.feature, top.importance_mean, xerr=top.importance_std, color="steelblue")
    ax.set_xlabel("Drop in ROC-AUC when the column is shuffled")
    ax.set_title("Permutation importance (raw input columns, test set)")
    _save(fig, "feature_importance_permutation.png")
    return imp


def plot_contribution_summary(pipeline, X_sample: pd.DataFrame) -> pd.DataFrame | None:
    """Beeswarm summary of per-row feature attributions.

    ``src.explain.Explainer`` uses SHAP (TreeExplainer / LinearExplainer) when the
    fitted estimator supports it and falls back to a model-agnostic occlusion
    attribution otherwise - which is what happens for the stacking ensemble,
    since exact SHAP for a stack of heterogeneous learners is prohibitively
    expensive. The figure title always states which method produced it.
    """
    from .explain import Explainer

    try:
        explainer = Explainer(pipeline)
        names = explainer.feature_names
        Xt = np.asarray(pipeline[:-1].transform(X_sample), dtype=float)
        contribs = explainer.contributions(X_sample)
        method = explainer.method

        fname = ("feature_importance_shap.png" if method.startswith("shap")
                 else "feature_importance_occlusion.png")
        label = {
            "shap_tree": "SHAP (TreeExplainer) - contribution to log-odds of churn",
            "shap_linear": "SHAP (LinearExplainer) - contribution to log-odds of churn",
            "occlusion": "Occlusion attribution - change in P(churn) when the "
                         "feature is replaced by its background distribution",
        }[method]

        if SHAP_AVAILABLE:
            fig = plt.figure(figsize=(8.5, 7))
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                shap.summary_plot(contribs, features=Xt, feature_names=names,
                                  show=False, max_display=20, plot_size=None)
            plt.title(label, fontsize=10)
            plt.xlabel(
                "SHAP value (log-odds)" if method.startswith("shap")
                else "Attribution (change in predicted probability of churn)"
            )
            _save(fig, fname)
        else:  # pragma: no cover - shap is pinned in requirements.txt
            order = np.argsort(np.abs(contribs).mean(axis=0))[-20:]
            fig, ax = plt.subplots(figsize=(8, 6))
            ax.barh([names[i] for i in order], np.abs(contribs).mean(axis=0)[order])
            ax.set_title(label)
            _save(fig, fname)

        imp = (
            pd.DataFrame({"feature": names,
                          "mean_abs_contribution": np.abs(contribs).mean(axis=0)})
            .sort_values("mean_abs_contribution", ascending=False)
            .reset_index(drop=True)
        )
        imp.to_csv(config.REPORT_DIR / "contribution_importance.csv", index=False)
        imp.attrs["method"] = method
        print(f"  attribution method: {method}")
        return imp
    except Exception as exc:  # pragma: no cover - defensive
        print(f"  attribution summary failed ({type(exc).__name__}: {exc}); "
              f"permutation importance is still available")
        return None


# --------------------------------------------------------------------------- #
def evaluate(make_figures: bool = True) -> dict:
    pipeline, metadata = load_artifacts()
    splits = make_splits()
    X_test, y_test = splits.X_test, splits.y_test
    threshold = float(metadata["chosen_threshold"])

    prob = pipeline.predict_proba(X_test)[:, 1]
    pred = (prob >= threshold).astype(int)
    pred_05 = (prob >= 0.5).astype(int)

    cm = confusion_matrix(y_test, pred)
    report_txt = classification_report(
        y_test, pred, target_names=["stay", "churn"], digits=4
    )
    metrics = {
        "model_name": metadata["model_name"],
        "threshold": threshold,
        "n_test": int(len(y_test)),
        "test_churn_rate": float(y_test.mean()),
        "accuracy": float(accuracy_score(y_test, pred)),
        "precision": float(precision_score(y_test, pred, zero_division=0)),
        "recall": float(recall_score(y_test, pred, zero_division=0)),
        "f1": float(f1_score(y_test, pred, zero_division=0)),
        "roc_auc": float(roc_auc_score(y_test, prob)),
        "pr_auc": float(average_precision_score(y_test, prob)),
        "brier": float(brier_score_loss(y_test, prob)),
        "log_loss": float(log_loss(y_test, prob)),
        "confusion_matrix": {
            "tn": int(cm[0, 0]), "fp": int(cm[0, 1]),
            "fn": int(cm[1, 0]), "tp": int(cm[1, 1]),
        },
        "at_threshold_0.5": {
            "accuracy": float(accuracy_score(y_test, pred_05)),
            "precision": float(precision_score(y_test, pred_05, zero_division=0)),
            "recall": float(recall_score(y_test, pred_05, zero_division=0)),
            "f1": float(f1_score(y_test, pred_05, zero_division=0)),
        },
        "expected_value": expected_value(y_test.to_numpy(), prob, threshold),
        "cost_assumptions": metadata["cost_matrix"],
    }

    sweep = threshold_sweep(y_test.to_numpy(), prob)
    best_row = sweep.loc[sweep["expected_value"].idxmax()]
    metrics["test_optimal_threshold"] = float(best_row["threshold"])
    metrics["test_optimal_ev_per_customer"] = float(best_row["ev_per_customer"])
    sweep.to_csv(config.REPORT_DIR / "threshold_sweep_test.csv", index=False)

    print("\n================ HELD-OUT TEST METRICS ================")
    print(f"model                 : {metrics['model_name']}")
    print(f"threshold             : {threshold:.2f}")
    for k in ("accuracy", "precision", "recall", "f1", "roc_auc", "pr_auc",
              "brier", "log_loss"):
        print(f"{k:<22}: {metrics[k]:.4f}")
    print(f"confusion matrix      : {metrics['confusion_matrix']}")
    ev = metrics["expected_value"]
    print(f"expected value/cust   : {ev['ev_per_customer']:.2f} "
          f"(do-nothing {ev['ev_do_nothing'] / len(y_test):.2f}, "
          f"contact-all {ev['ev_contact_all'] / len(y_test):.2f})")
    print("\n" + report_txt)

    config.CLASSIFICATION_REPORT_PATH.write_text(
        f"Model: {metrics['model_name']}   threshold={threshold:.2f}\n\n"
        + report_txt
        + f"\nconfusion matrix (rows=actual, cols=predicted):\n{cm}\n"
    )
    config.TEST_METRICS_PATH.write_text(json.dumps(metrics, indent=2) + "\n")

    if make_figures:
        print("\ngenerating figures...")
        plot_roc(y_test, prob, metrics["roc_auc"])
        plot_pr(y_test, prob, metrics["pr_auc"], threshold)
        plot_confusion(cm, threshold)
        plot_calibration(y_test, prob, metrics["brier"])
        plot_threshold_sweep(sweep, threshold)
        plot_learning_curve(pipeline, splits.X_trainval, splits.y_trainval)
        perm = plot_permutation_importance(pipeline, X_test, y_test)
        contrib_imp = plot_contribution_summary(
            pipeline, X_test.sample(min(500, len(X_test)),
                                    random_state=config.RANDOM_SEED)
        )
        metrics["top_features_permutation"] = perm.head(10).to_dict(orient="records")
        if contrib_imp is not None:
            metrics["top_features_attribution"] = contrib_imp.head(10).to_dict(
                orient="records"
            )
            metrics["attribution_method"] = contrib_imp.attrs.get("method")
        else:
            metrics["attribution_method"] = "permutation_only"
        config.TEST_METRICS_PATH.write_text(json.dumps(metrics, indent=2) + "\n")

    print(f"\nmetrics -> {config.TEST_METRICS_PATH}")
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate the persisted model.")
    parser.add_argument("--no-figures", action="store_true")
    args = parser.parse_args()
    evaluate(make_figures=not args.no_figures)


if __name__ == "__main__":
    main()
