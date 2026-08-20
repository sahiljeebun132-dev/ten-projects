"""Model search, comparison, selection and persistence.

Flow
----
1. Stratified 60/20/20 split (``src.data.make_splits``).
2. For each model family: ``RandomizedSearchCV`` (stratified 5-fold, multi-metric
   ROC-AUC + PR-AUC) over the *whole pipeline*, so preprocessing is refit inside
   every fold -> no leakage from validation folds into imputers/scalers.
3. Every candidate of every search is appended to ``reports/experiments.csv``.
4. The tuned families are scored on the untouched validation split and the
   winner is picked on validation PR-AUC (the right metric for an imbalanced
   retention problem).
5. The winner is refit on train+val; the decision threshold is chosen from
   *out-of-fold* predictions on train+val by maximising expected value under the
   cost matrix in ``src.config``.
6. Pipeline -> ``models/churn_model.joblib``, metadata -> ``models/metadata.json``.
"""
from __future__ import annotations

import argparse
import json
import platform
import time
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import (
    GradientBoostingClassifier,
    HistGradientBoostingClassifier,
    RandomForestClassifier,
    StackingClassifier,
)
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import (
    RandomizedSearchCV,
    StratifiedKFold,
    cross_val_predict,
)

from . import config
from .data import Splits, class_balance, make_splits
from .features import build_model_pipeline, get_feature_names

# --------------------------------------------------------------------------- #
# model zoo
# --------------------------------------------------------------------------- #
def base_estimators(seed: int = config.RANDOM_SEED) -> dict[str, object]:
    return {
        "logistic_regression": LogisticRegression(
            max_iter=3000, solver="saga", random_state=seed
        ),
        "random_forest": RandomForestClassifier(
            n_estimators=300, n_jobs=config.N_JOBS, random_state=seed
        ),
        "gradient_boosting": GradientBoostingClassifier(random_state=seed),
        "hist_gradient_boosting": HistGradientBoostingClassifier(
            random_state=seed, early_stopping=False
        ),
    }


def build_stacking(tuned: dict[str, object], seed: int = config.RANDOM_SEED
                   ) -> StackingClassifier:
    """Stack the tuned base learners behind a logistic meta-learner."""
    members = []
    for name in ("logistic_regression", "random_forest", "hist_gradient_boosting"):
        est = tuned.get(name)
        if est is None:
            continue
        est = sklearn.base.clone(est)
        params = est.get_params()
        # keep the ensemble affordable: no nested parallelism, capped forest size
        if "n_jobs" in params:
            est.set_params(n_jobs=1)
        if "n_estimators" in params and isinstance(params["n_estimators"], (int,)):
            est.set_params(n_estimators=min(params["n_estimators"], 250))
        members.append((name, est))
    return StackingClassifier(
        estimators=members,
        final_estimator=LogisticRegression(max_iter=2000, random_state=seed),
        cv=3,
        stack_method="predict_proba",
        n_jobs=1,
        passthrough=False,
    )


# --------------------------------------------------------------------------- #
# expected value / threshold selection
# --------------------------------------------------------------------------- #
def per_customer_value(y_true: np.ndarray, pred: np.ndarray) -> np.ndarray:
    """Per-customer realised value of a contact decision (currency units)."""
    V = config.VALUE_OF_RETAINED_CUSTOMER
    C = config.RETENTION_OFFER_COST
    s = config.RETENTION_SUCCESS_RATE
    y_true = np.asarray(y_true).astype(int)
    pred = np.asarray(pred).astype(int)
    value = np.zeros(len(y_true), dtype=float)
    value[(pred == 1) & (y_true == 1)] = -C - (1 - s) * V
    value[(pred == 1) & (y_true == 0)] = -C
    value[(pred == 0) & (y_true == 1)] = -V
    return value


def expected_value(y_true: np.ndarray, y_prob: np.ndarray, threshold: float) -> dict:
    """Expected value (in currency units) of acting on everyone above ``threshold``.

    Baseline = do nothing, which costs ``V`` for every churner.  Contacting a
    customer costs ``C`` and saves a true churner with probability ``s``.
    """
    V = config.VALUE_OF_RETAINED_CUSTOMER
    C = config.RETENTION_OFFER_COST
    s = config.RETENTION_SUCCESS_RATE

    y_true = np.asarray(y_true).astype(int)
    pred = (np.asarray(y_prob) >= threshold).astype(int)

    tp = int(((pred == 1) & (y_true == 1)).sum())
    fp = int(((pred == 1) & (y_true == 0)).sum())
    fn = int(((pred == 0) & (y_true == 1)).sum())
    tn = int(((pred == 0) & (y_true == 0)).sum())
    n = len(y_true)

    # contacted churner: pay C, still lose V with prob (1-s)
    per_customer = per_customer_value(y_true, pred)
    value = float(per_customer.sum())
    se = float(per_customer.std(ddof=1) / np.sqrt(n)) if n > 1 else 0.0
    do_nothing = -V * int(y_true.sum())
    contact_all = int(y_true.sum()) * (-C - (1 - s) * V) + int((y_true == 0).sum()) * (-C)

    return {
        "threshold": float(threshold),
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "n_contacted": tp + fp,
        "expected_value": float(value),
        "ev_per_customer": float(value / n),
        "ev_per_customer_se": se,
        "uplift_vs_do_nothing": float(value - do_nothing),
        "uplift_vs_contact_all": float(value - contact_all),
        "ev_do_nothing": float(do_nothing),
        "ev_contact_all": float(contact_all),
    }


def threshold_sweep(y_true: np.ndarray, y_prob: np.ndarray,
                    grid: np.ndarray = config.THRESHOLD_GRID) -> pd.DataFrame:
    """Precision/recall/F1/EV across the threshold grid."""
    from sklearn.metrics import f1_score, precision_score, recall_score

    rows = []
    for t in grid:
        pred = (y_prob >= t).astype(int)
        ev = expected_value(y_true, y_prob, t)
        rows.append(
            {
                "threshold": float(t),
                "precision": precision_score(y_true, pred, zero_division=0),
                "recall": recall_score(y_true, pred, zero_division=0),
                "f1": f1_score(y_true, pred, zero_division=0),
                "contact_rate": float(pred.mean()),
                "expected_value": ev["expected_value"],
                "ev_per_customer": ev["ev_per_customer"],
                "ev_per_customer_se": ev["ev_per_customer_se"],
                "uplift_vs_do_nothing": ev["uplift_vs_do_nothing"],
            }
        )
    return pd.DataFrame(rows)


def choose_threshold(y_true: np.ndarray, y_prob: np.ndarray,
                     *, one_se_rule: bool = True) -> tuple[float, pd.DataFrame]:
    """Pick the operating point that maximises expected value.

    The EV curve is deliberately flat near its peak (moving the threshold a few
    points swaps a handful of customers between "contact" and "ignore"), so the
    raw argmax is noisy. With ``one_se_rule`` we keep every threshold whose EV is
    within one standard error of the best and, among those statistically
    indistinguishable options, pick the one closest to the analytical break-even
    ``p* = C / (s * V)``. That makes the chosen point theory-consistent and
    stable across re-runs instead of an artefact of a few hundred customers.
    """
    sweep = threshold_sweep(y_true, y_prob)
    best_idx = int(sweep["expected_value"].idxmax())
    best_row = sweep.loc[best_idx]
    if not one_se_rule:
        return float(best_row["threshold"]), sweep

    n = len(y_true)
    tolerance = float(best_row["ev_per_customer_se"]) * n  # 1 SE on the total
    within = sweep[sweep["expected_value"] >= best_row["expected_value"] - tolerance]
    chosen = within.iloc[
        (within["threshold"] - config.BREAK_EVEN_THRESHOLD).abs().argmin()
    ]
    return float(chosen["threshold"]), sweep


# --------------------------------------------------------------------------- #
# experiment logging
# --------------------------------------------------------------------------- #
def _log_search(model_name: str, search: RandomizedSearchCV, run_id: str,
                rows: list[dict]) -> None:
    cv = search.cv_results_
    for i in range(len(cv["params"])):
        rows.append(
            {
                "run_id": run_id,
                "model": model_name,
                "candidate": i,
                "params": json.dumps(
                    {k.replace("clf__", ""): _jsonable(v)
                     for k, v in cv["params"][i].items()},
                    sort_keys=True,
                ),
                "cv_roc_auc_mean": float(cv["mean_test_roc_auc"][i]),
                "cv_roc_auc_std": float(cv["std_test_roc_auc"][i]),
                "cv_pr_auc_mean": float(cv["mean_test_average_precision"][i]),
                "cv_pr_auc_std": float(cv["std_test_average_precision"][i]),
                "fit_time_sec": float(cv["mean_fit_time"][i]),
                "rank_roc_auc": int(cv["rank_test_roc_auc"][i]),
                "is_best": bool(cv["rank_test_roc_auc"][i] == 1),
            }
        )


def _jsonable(v):
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return round(float(v), 6)
    return v


# --------------------------------------------------------------------------- #
# main training routine
# --------------------------------------------------------------------------- #
def evaluate_probs(y_true, y_prob, threshold: float) -> dict:
    from sklearn.metrics import (
        accuracy_score, average_precision_score, brier_score_loss, f1_score,
        precision_score, recall_score, roc_auc_score,
    )

    pred = (np.asarray(y_prob) >= threshold).astype(int)
    return {
        "accuracy": float(accuracy_score(y_true, pred)),
        "precision": float(precision_score(y_true, pred, zero_division=0)),
        "recall": float(recall_score(y_true, pred, zero_division=0)),
        "f1": float(f1_score(y_true, pred, zero_division=0)),
        "roc_auc": float(roc_auc_score(y_true, y_prob)),
        "pr_auc": float(average_precision_score(y_true, y_prob)),
        "brier": float(brier_score_loss(y_true, y_prob)),
    }


def train(
    splits: Splits | None = None,
    *,
    training_date: str | None = None,
    seed: int = config.RANDOM_SEED,
    models: list[str] | None = None,
    fast: bool = False,
) -> dict:
    t_start = time.time()
    splits = splits or make_splits(seed=seed)
    models = models or config.MODEL_ORDER
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    training_date = training_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    cv = StratifiedKFold(n_splits=config.CV_FOLDS, shuffle=True, random_state=seed)
    experiment_rows: list[dict] = []
    tuned_estimators: dict[str, object] = {}
    tuned_pipelines: dict[str, object] = {}
    comparison: list[dict] = []

    for name in models:
        if name == "stacking_ensemble":
            if not tuned_estimators:
                continue
            estimator = build_stacking(tuned_estimators, seed=seed)
        else:
            estimator = base_estimators(seed)[name]

        pipe = build_model_pipeline(estimator)
        n_iter = 3 if fast else config.N_ITER_PER_MODEL.get(name, config.N_ITER_SEARCH)

        print(f"\n=== {name}: RandomizedSearchCV ({n_iter} candidates x "
              f"{config.CV_FOLDS} folds) ===", flush=True)
        t0 = time.time()
        search = RandomizedSearchCV(
            pipe,
            param_distributions=config.PARAM_GRIDS[name],
            n_iter=n_iter,
            scoring=config.SEARCH_SCORING,
            refit=config.REFIT_METRIC,
            cv=cv,
            n_jobs=config.N_JOBS,
            random_state=seed,
            error_score=np.nan,
            verbose=0,
        )
        search.fit(splits.X_train, splits.y_train)
        elapsed = time.time() - t0

        _log_search(name, search, run_id, experiment_rows)
        best_pipe = search.best_estimator_
        tuned_estimators[name] = sklearn.base.clone(best_pipe.named_steps["clf"])
        tuned_pipelines[name] = best_pipe

        val_prob = best_pipe.predict_proba(splits.X_val)[:, 1]
        val_metrics = evaluate_probs(splits.y_val, val_prob, 0.5)
        val_thr, _ = choose_threshold(splits.y_val.to_numpy(), val_prob)
        val_ev = expected_value(splits.y_val.to_numpy(), val_prob, val_thr)

        comparison.append(
            {
                "model": name,
                "cv_roc_auc": float(search.cv_results_["mean_test_roc_auc"][search.best_index_]),
                "cv_roc_auc_std": float(search.cv_results_["std_test_roc_auc"][search.best_index_]),
                "cv_pr_auc": float(
                    search.cv_results_["mean_test_average_precision"][search.best_index_]
                ),
                "val_roc_auc": val_metrics["roc_auc"],
                "val_pr_auc": val_metrics["pr_auc"],
                "val_brier": val_metrics["brier"],
                "val_f1_at_0.5": val_metrics["f1"],
                "val_best_threshold": val_thr,
                "val_ev_per_customer": val_ev["ev_per_customer"],
                "search_seconds": round(elapsed, 1),
                "best_params": json.dumps(
                    {k.replace("clf__", ""): _jsonable(v)
                     for k, v in search.best_params_.items()},
                    sort_keys=True,
                ),
            }
        )
        print(
            f"  best CV ROC-AUC={comparison[-1]['cv_roc_auc']:.4f} | "
            f"val ROC-AUC={val_metrics['roc_auc']:.4f} | "
            f"val PR-AUC={val_metrics['pr_auc']:.4f} | {elapsed:.0f}s",
            flush=True,
        )

    comparison_df = pd.DataFrame(comparison).sort_values("val_pr_auc", ascending=False)
    comparison_df.to_csv(config.MODEL_COMPARISON_PATH, index=False)

    exp_df = pd.DataFrame(experiment_rows)
    exp_df.insert(0, "logged_at", datetime.now(timezone.utc).isoformat(timespec="seconds"))
    header = not config.EXPERIMENTS_PATH.exists()
    exp_df.to_csv(config.EXPERIMENTS_PATH, mode="a", header=header, index=False)

    # ------------------------------------------------------------------ #
    # winner: highest validation PR-AUC
    # ------------------------------------------------------------------ #
    best_name = str(comparison_df.iloc[0]["model"])
    best_pipeline = sklearn.base.clone(tuned_pipelines[best_name])
    print(f"\n>>> selected '{best_name}' on validation PR-AUC "
          f"({comparison_df.iloc[0]['val_pr_auc']:.4f})", flush=True)

    # Threshold from out-of-fold predictions on train+val (never touches test).
    X_tv, y_tv = splits.X_trainval, splits.y_trainval
    print("computing out-of-fold probabilities on train+val for threshold tuning...",
          flush=True)
    oof_prob = cross_val_predict(
        sklearn.base.clone(best_pipeline), X_tv, y_tv, cv=cv,
        method="predict_proba", n_jobs=1,
    )[:, 1]
    threshold, sweep = choose_threshold(y_tv.to_numpy(), oof_prob)
    sweep.to_csv(config.THRESHOLD_SWEEP_PATH, index=False)
    pd.DataFrame({"y_true": y_tv.to_numpy(), "oof_probability": oof_prob}).to_csv(
        config.REPORT_DIR / "oof_predictions.csv", index=False
    )
    oof_metrics = evaluate_probs(y_tv, oof_prob, threshold)
    oof_ev = expected_value(y_tv.to_numpy(), oof_prob, threshold)
    print(f"    chosen threshold = {threshold:.2f} "
          f"(analytical break-even = {config.BREAK_EVEN_THRESHOLD:.3f})", flush=True)

    # Final refit on train+val.
    best_pipeline.fit(X_tv, y_tv)
    joblib.dump(best_pipeline, config.MODEL_PATH)

    # Small transformed background sample for SHAP / contribution explanations.
    pre = best_pipeline[:-1]
    background = pre.transform(X_tv.sample(min(300, len(X_tv)), random_state=seed))
    joblib.dump(
        {"background": np.asarray(background),
         "feature_names": get_feature_names(best_pipeline)},
        config.BACKGROUND_PATH,
    )

    metadata = {
        "model_name": best_name,
        "model_class": type(best_pipeline.named_steps["clf"]).__name__,
        "training_date": training_date,
        "run_id": run_id,
        "sklearn_version": sklearn.__version__,
        "numpy_version": np.__version__,
        "pandas_version": pd.__version__,
        "python_version": platform.python_version(),
        "random_seed": seed,
        "raw_feature_columns": config.FEATURE_COLUMNS,
        "numeric_features": config.NUMERIC_FEATURES,
        "categorical_features": config.CATEGORICAL_FEATURES,
        "engineered_features": config.ENGINEERED_NUMERIC + config.ENGINEERED_CATEGORICAL,
        "model_feature_names": get_feature_names(best_pipeline),
        "n_model_features": len(get_feature_names(best_pipeline)),
        "best_params": json.loads(comparison_df.iloc[0]["best_params"]),
        "chosen_threshold": threshold,
        "threshold_rule": (
            "maximise expected value on out-of-fold train+val predictions under "
            "the cost matrix below; among thresholds within one standard error of "
            "the maximum, take the one closest to the analytical break-even "
            "p* = C / (s * V)"
        ),
        "analytical_break_even_threshold": config.BREAK_EVEN_THRESHOLD,
        "cost_matrix": {
            "value_of_retained_customer": config.VALUE_OF_RETAINED_CUSTOMER,
            "retention_offer_cost": config.RETENTION_OFFER_COST,
            "retention_success_rate": config.RETENTION_SUCCESS_RATE,
        },
        "class_balance": {
            "train": class_balance(splits.y_train),
            "val": class_balance(splits.y_val),
            "test": class_balance(splits.y_test),
        },
        "cv_metrics": {
            "folds": config.CV_FOLDS,
            "roc_auc": float(comparison_df.iloc[0]["cv_roc_auc"]),
            "pr_auc": float(comparison_df.iloc[0]["cv_pr_auc"]),
        },
        "validation_metrics": {
            "roc_auc": float(comparison_df.iloc[0]["val_roc_auc"]),
            "pr_auc": float(comparison_df.iloc[0]["val_pr_auc"]),
            "brier": float(comparison_df.iloc[0]["val_brier"]),
        },
        "oof_trainval_metrics": oof_metrics,
        "oof_trainval_expected_value": oof_ev,
        "model_comparison": comparison_df.to_dict(orient="records"),
        "train_duration_sec": round(time.time() - t_start, 1),
        "artifacts": {
            "model": str(config.MODEL_PATH.relative_to(config.PROJECT_ROOT)),
            "background": str(config.BACKGROUND_PATH.relative_to(config.PROJECT_ROOT)),
            "experiments": str(config.EXPERIMENTS_PATH.relative_to(config.PROJECT_ROOT)),
        },
    }
    config.METADATA_PATH.write_text(json.dumps(metadata, indent=2) + "\n")

    print(f"\nsaved model -> {config.MODEL_PATH}")
    print(f"saved metadata -> {config.METADATA_PATH}")
    print(f"logged {len(experiment_rows)} candidate runs -> {config.EXPERIMENTS_PATH}")
    print(f"total wall time: {metadata['train_duration_sec']}s")
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the churn model.")
    parser.add_argument("--training-date", default=None,
                        help="Training date recorded in metadata.json (YYYY-MM-DD).")
    parser.add_argument("--seed", type=int, default=config.RANDOM_SEED)
    parser.add_argument("--models", nargs="*", default=None,
                        help=f"Subset of {config.MODEL_ORDER}")
    parser.add_argument("--fast", action="store_true",
                        help="3 candidates per family - smoke-test mode.")
    args = parser.parse_args()
    train(training_date=args.training_date, seed=args.seed, models=args.models,
          fast=args.fast)


if __name__ == "__main__":
    main()
