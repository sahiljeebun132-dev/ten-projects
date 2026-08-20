"""Regenerate notebooks/exploration.ipynb from source cells.

The notebook is executed (and its outputs stored) with:
    make notebook
Keeping the cell source here makes the EDA narrative diff-able in review.
"""
from __future__ import annotations

from pathlib import Path

import nbformat as nbf

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "notebooks" / "exploration.ipynb"

CELLS: list[tuple[str, str]] = [
    ("md", """# Customer Churn - Exploratory Data Analysis

This notebook is the *analysis* companion to the modelling code in `src/`.
It answers four questions before any model is fitted:

1. What does the data look like, and where is it missing?
2. How imbalanced is the target, and which raw signals separate the classes?
3. Are there interactions that a linear model would miss?
4. Do the two suspicious-looking columns (`churn_risk_score_v0`,
   `account_flagged_for_review`) actually leak the label?

The dataset is **synthetic** and produced offline by `data/generate_data.py`
with a fixed seed - see the README for the latent process."""),

    ("code", """import json
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

ROOT = Path.cwd().parent if Path.cwd().name == "notebooks" else Path.cwd()
sys.path.insert(0, str(ROOT))

from src import config
from src.data import make_splits
from src.features import FeatureEngineer

sns.set_theme(style="whitegrid", palette=config.PALETTE)
pd.set_option("display.width", 120, "display.max_columns", 40)
FIG = config.FIGURE_DIR

df = pd.read_csv(config.RAW_DATA_PATH)
print(f"rows={len(df):,}  columns={df.shape[1]}")
df.head()"""),

    ("md", "## 1. Schema, dtypes and missingness"),

    ("code", """profile = pd.DataFrame({
    "dtype": df.dtypes.astype(str),
    "n_missing": df.isna().sum(),
    "pct_missing": (df.isna().mean() * 100).round(2),
    "n_unique": df.nunique(),
})
profile"""),

    ("code", """miss = (df.isna().mean() * 100)
miss = miss[miss > 0].sort_values()
fig, ax = plt.subplots(figsize=(7.5, 3.6))
ax.barh(miss.index, miss.values, color="indianred")
ax.set_xlabel("% missing")
ax.set_title("Missing values by column")
for i, v in enumerate(miss.values):
    ax.text(v + 0.05, i, f"{v:.1f}%", va="center", fontsize=9)
fig.tight_layout()
fig.savefig(FIG / "eda_missingness.png", dpi=config.FIG_DPI)
plt.show()

# Missingness in total_charges is concentrated in brand-new accounts:
print(df.assign(missing_total=df.total_charges.isna())
        .groupby(df.tenure_months <= 2)["missing_total"].mean().rename(
            index={True: "tenure <= 2m", False: "tenure > 2m"}).round(3))"""),

    ("md", """## 2. Target balance and univariate separation

~26% of customers churn: imbalanced enough that accuracy is a useless headline
metric, which is why the project reports PR-AUC and picks a cost-based
threshold instead of the default 0.5."""),

    ("code", """rate = df[config.TARGET].mean()
fig, axes = plt.subplots(1, 3, figsize=(15, 4.2))

df[config.TARGET].value_counts().sort_index().plot(
    kind="bar", ax=axes[0], color=["#4c72b0", "#c44e52"])
axes[0].set_xticklabels(["stay", "churn"], rotation=0)
axes[0].set_title(f"Class balance (churn rate = {rate:.1%})")
axes[0].set_ylabel("customers")

(df.groupby("contract_type")[config.TARGET].mean().sort_values()
   .plot(kind="barh", ax=axes[1], color="#4c72b0"))
axes[1].axvline(rate, color="k", ls="--", lw=1)
axes[1].set_title("Churn rate by contract type")
axes[1].set_xlabel("churn rate")

(df.groupby("payment_method")[config.TARGET].mean().sort_values()
   .plot(kind="barh", ax=axes[2], color="#55a868"))
axes[2].axvline(rate, color="k", ls="--", lw=1)
axes[2].set_title("Churn rate by payment method")
axes[2].set_xlabel("churn rate")

fig.tight_layout()
fig.savefig(FIG / "eda_churn_rates.png", dpi=config.FIG_DPI)
plt.show()"""),

    ("code", """num_cols = ["tenure_months", "monthly_charges", "total_charges",
            "num_support_tickets", "avg_monthly_usage_gb", "last_login_days"]
fig, axes = plt.subplots(2, 3, figsize=(15, 7.5))
for ax, col in zip(axes.ravel(), num_cols):
    for label, sub in df.groupby(config.TARGET):
        sns.kdeplot(sub[col].dropna(), ax=ax, fill=True, alpha=0.35,
                    label="churn" if label else "stay", warn_singular=False)
    ax.set_title(col)
    ax.legend(fontsize=8)
fig.suptitle("Numeric feature distributions by outcome", y=1.02)
fig.tight_layout()
fig.savefig(FIG / "eda_numeric_distributions.png", dpi=config.FIG_DPI,
            bbox_inches="tight")
plt.show()"""),

    ("code", """from sklearn.metrics import roc_auc_score

rows = []
for col in config.NUMERIC_FEATURES:
    s = df[col].fillna(df[col].median())
    rows.append({"feature": col,
                 "univariate_auc": roc_auc_score(df[config.TARGET], s),
                 "point_biserial_r": np.corrcoef(s, df[config.TARGET])[0, 1]})
uni = pd.DataFrame(rows).assign(
    strength=lambda d: (d.univariate_auc - 0.5).abs()
).sort_values("strength", ascending=False).drop(columns="strength")
uni.round(3)"""),

    ("md", """## 3. Interactions

The generator embeds genuine interactions - price sensitivity is much stronger
for customers without a lock-in, and heavy spenders who barely use the service
are the worst risk of all. This is why tree ensembles edge out the logistic
regression."""),

    ("code", """tmp = df.assign(
    charge_q=pd.qcut(df.monthly_charges, 4, labels=["Q1 (cheap)", "Q2", "Q3", "Q4 (dear)"]),
    usage_q=pd.qcut(df.avg_monthly_usage_gb, 4,
                    labels=["low", "mid-low", "mid-high", "high"]),
)
pivot = tmp.pivot_table(index="charge_q", columns="contract_type",
                        values=config.TARGET, aggfunc="mean", observed=True)
pivot2 = tmp.pivot_table(index="charge_q", columns="usage_q",
                         values=config.TARGET, aggfunc="mean", observed=True)

fig, axes = plt.subplots(1, 2, figsize=(13, 4.4))
sns.heatmap(pivot, annot=True, fmt=".1%", cmap="Reds", ax=axes[0], cbar=False)
axes[0].set_title("Churn rate: monthly charges x contract type")
sns.heatmap(pivot2, annot=True, fmt=".1%", cmap="Reds", ax=axes[1], cbar=False)
axes[1].set_title("Churn rate: monthly charges x usage")
fig.tight_layout()
fig.savefig(FIG / "eda_interactions.png", dpi=config.FIG_DPI)
plt.show()

print("price sensitivity (Q4 - Q1 churn rate) by contract:")
print((pivot.iloc[-1] - pivot.iloc[0]).round(3))"""),

    ("code", """corr = df[config.NUMERIC_FEATURES + [config.TARGET]].corr(numeric_only=True)
fig, ax = plt.subplots(figsize=(8.5, 6.5))
sns.heatmap(corr, annot=True, fmt=".2f", cmap="coolwarm", center=0,
            square=True, ax=ax, cbar_kws={"shrink": 0.75}, annot_kws={"size": 8})
ax.set_title("Correlation matrix (numeric features + target)")
fig.tight_layout()
fig.savefig(FIG / "eda_correlation.png", dpi=config.FIG_DPI)
plt.show()"""),

    ("md", """## 4. Red herrings: do the suspicious columns leak?

`churn_risk_score_v0` (a "legacy risk score") and `account_flagged_for_review`
(a back-office flag) both *sound* like post-outcome information. They are drawn
independently of the latent churn process, and the numbers below confirm it -
both sit on top of AUC 0.50. They are kept as model inputs precisely so that the
importance plots demonstrate the model ignores them."""),

    ("code", """checks = []
for col in config.RED_HERRING_FEATURES:
    s = df[col].fillna(0)
    churn_mean = df.loc[df[config.TARGET] == 1, col].mean()
    stay_mean = df.loc[df[config.TARGET] == 0, col].mean()
    checks.append({"column": col,
                   "auc": round(roc_auc_score(df[config.TARGET], s), 4),
                   "mean_if_churn": round(float(churn_mean), 3),
                   "mean_if_stay": round(float(stay_mean), 3)})
pd.DataFrame(checks)"""),

    ("md", """## 5. Engineered features

`FeatureEngineer` (in `src/features.py`) is fitted on the **training split
only**; the cell below fits it on train and applies it to the validation split,
exactly as the pipeline does at training time."""),

    ("code", """splits = make_splits()
fe = FeatureEngineer().fit(splits.X_train)
eng = fe.transform(splits.X_val)
eng_cols = config.ENGINEERED_NUMERIC + config.ENGINEERED_CATEGORICAL
eng[eng_cols].head(8)"""),

    ("code", """eng_with_y = eng.assign(churn=splits.y_val.values)
fig, axes = plt.subplots(1, 3, figsize=(15, 4.2))
sns.boxplot(data=eng_with_y, x="churn", y="charges_per_tenure_month",
            ax=axes[0], showfliers=False)
axes[0].set_title("charges_per_tenure_month")
sns.boxplot(data=eng_with_y, x="churn", y="usage_z_by_contract",
            ax=axes[1], showfliers=False)
axes[1].set_title("usage_z_by_contract")
(eng_with_y.groupby("tenure_bucket", observed=True)["churn"].mean()
    .reindex(config.TENURE_LABELS).plot(kind="bar", ax=axes[2], color="#c44e52"))
axes[2].set_title("churn rate by tenure_bucket")
axes[2].tick_params(axis="x", rotation=0)
fig.tight_layout()
fig.savefig(FIG / "eda_engineered_features.png", dpi=config.FIG_DPI)
plt.show()"""),

    ("md", """## 6. Modelling results

Loaded from the artifacts written by `make train` / `make evaluate` so the
notebook never re-states numbers by hand."""),

    ("code", """comparison = pd.read_csv(config.MODEL_COMPARISON_PATH)
comparison[["model", "cv_roc_auc", "val_roc_auc", "val_pr_auc",
            "val_brier", "search_seconds"]].round(4)"""),

    ("code", """metrics = json.loads(config.TEST_METRICS_PATH.read_text())
summary = {k: round(metrics[k], 4) for k in
           ["accuracy", "precision", "recall", "f1", "roc_auc", "pr_auc", "brier"]}
summary["threshold"] = metrics["threshold"]
summary["model"] = metrics["model_name"]
print(json.dumps(summary, indent=2))
print("\\nconfusion matrix:", metrics["confusion_matrix"])
ev = metrics["expected_value"]
print(f"expected value per customer: {ev['ev_per_customer']:.2f} "
      f"(vs {ev['ev_do_nothing'] / metrics['n_test']:.2f} doing nothing)")"""),

    ("md", """## Takeaways

* **Contract type dominates.** Month-to-month customers churn several times more
  often than two-year customers; tenure is the second-strongest signal.
* **Price only bites without lock-in.** The charge x contract heatmap shows the
  interaction that motivates tree ensembles over a plain GLM.
* **The scary-looking columns are noise.** Both red herrings sit at AUC ~0.50 and
  the model's importance ranking puts them at the bottom - a useful reminder that
  a column name is not evidence of leakage (and vice versa).
* **Missingness is structural, not random.** `total_charges` is missing almost
  exclusively for brand-new accounts, so median imputation inside the pipeline
  plus the `tenure_bucket` feature keeps that information usable."""),
]


def build() -> None:
    nb = nbf.v4.new_notebook()
    nb.cells = [
        nbf.v4.new_markdown_cell(src) if kind == "md" else nbf.v4.new_code_cell(src)
        for kind, src in CELLS
    ]
    nb.metadata.update(
        {
            "kernelspec": {"display_name": "Python 3", "language": "python",
                           "name": "python3"},
            "language_info": {"name": "python", "version": "3.11"},
        }
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    nbf.write(nb, OUT)
    print(f"wrote {OUT} ({len(nb.cells)} cells)")


if __name__ == "__main__":
    build()
