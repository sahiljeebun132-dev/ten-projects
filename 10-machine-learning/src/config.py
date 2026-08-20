"""Central configuration: paths, seeds, schema, feature lists, search spaces, costs.

Everything that a reviewer might want to change lives here so that the rest of
the code contains logic only.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from scipy.stats import loguniform, randint, uniform

# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"
MODEL_DIR = PROJECT_ROOT / "models"
REPORT_DIR = PROJECT_ROOT / "reports"
FIGURE_DIR = REPORT_DIR / "figures"
NOTEBOOK_DIR = PROJECT_ROOT / "notebooks"

RAW_DATA_PATH = DATA_DIR / "churn.csv"
SAMPLE_INPUT_PATH = DATA_DIR / "sample_input.json"
SAMPLE_BATCH_PATH = DATA_DIR / "sample_batch.csv"

MODEL_PATH = MODEL_DIR / "churn_model.joblib"
BACKGROUND_PATH = MODEL_DIR / "background.joblib"
METADATA_PATH = MODEL_DIR / "metadata.json"

EXPERIMENTS_PATH = REPORT_DIR / "experiments.csv"
TEST_METRICS_PATH = REPORT_DIR / "test_metrics.json"
THRESHOLD_SWEEP_PATH = REPORT_DIR / "threshold_sweep.csv"
MODEL_COMPARISON_PATH = REPORT_DIR / "model_comparison.csv"
CLASSIFICATION_REPORT_PATH = REPORT_DIR / "classification_report.txt"

for _d in (DATA_DIR, MODEL_DIR, REPORT_DIR, FIGURE_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# --------------------------------------------------------------------------- #
# Reproducibility / data generation
# --------------------------------------------------------------------------- #
RANDOM_SEED = 20250820
N_ROWS = 15_000
TARGET_CHURN_RATE = 0.26  # generator calibrates the intercept to hit this

# --------------------------------------------------------------------------- #
# Splits
# --------------------------------------------------------------------------- #
TEST_SIZE = 0.20   # held out until the very end
VAL_SIZE = 0.20    # carved out of the remaining 80% -> 60/20/20 overall
CV_FOLDS = 5

# --------------------------------------------------------------------------- #
# Schema
# --------------------------------------------------------------------------- #
TARGET = "churn"
ID_COLUMN = "customer_id"

NUMERIC_FEATURES = [
    "tenure_months",
    "monthly_charges",
    "total_charges",
    "num_support_tickets",
    "avg_monthly_usage_gb",
    "num_dependents",
    "last_login_days",
    "churn_risk_score_v0",  # red herring: legacy score, pure noise (see README)
]

CATEGORICAL_FEATURES = [
    "contract_type",
    "payment_method",
    "internet_service",
    "region",
    "has_streaming",
    "is_senior",
    "account_flagged_for_review",  # red herring: independent of the target
]

# Engineered columns produced inside the pipeline by FeatureEngineer.
ENGINEERED_NUMERIC = [
    "charges_per_tenure_month",
    "tickets_per_tenure_year",
    "usage_z_by_contract",
]
ENGINEERED_CATEGORICAL = ["tenure_bucket"]

MODEL_NUMERIC = NUMERIC_FEATURES + ENGINEERED_NUMERIC
MODEL_CATEGORICAL = CATEGORICAL_FEATURES + ENGINEERED_CATEGORICAL

FEATURE_COLUMNS = NUMERIC_FEATURES + CATEGORICAL_FEATURES  # raw input contract
ALL_COLUMNS = [ID_COLUMN] + FEATURE_COLUMNS + [TARGET]

# Columns that are deliberately *named* as if they leaked but do not.
RED_HERRING_FEATURES = ["churn_risk_score_v0", "account_flagged_for_review"]

# Allowed category values -> used by schema validation and the API.
CATEGORY_LEVELS: dict[str, list] = {
    "contract_type": ["Month-to-month", "One year", "Two year"],
    "payment_method": [
        "Electronic check",
        "Mailed check",
        "Bank transfer (automatic)",
        "Credit card (automatic)",
    ],
    "internet_service": ["DSL", "Fiber optic", "No internet service"],
    "region": ["North", "South", "East", "West"],
    "has_streaming": [0, 1],
    "is_senior": [0, 1],
    "account_flagged_for_review": [0, 1],
}

TENURE_BINS = [0, 6, 12, 24, 48, np.inf]
TENURE_LABELS = ["0-6m", "7-12m", "13-24m", "25-48m", "49m+"]

# Plausible physical ranges, checked by validate_schema().
NUMERIC_RANGES: dict[str, tuple[float, float]] = {
    "tenure_months": (1, 72),
    "monthly_charges": (15.0, 200.0),
    "total_charges": (0.0, 15_000.0),
    "num_support_tickets": (0, 30),
    "avg_monthly_usage_gb": (0.0, 2_000.0),
    "num_dependents": (0, 6),
    "last_login_days": (0, 365),
    "churn_risk_score_v0": (0.0, 100.0),
}

# --------------------------------------------------------------------------- #
# Cost matrix / business assumptions (see README for the rationale)
# --------------------------------------------------------------------------- #
VALUE_OF_RETAINED_CUSTOMER = 500.0   # 12-month gross margin lost when a customer churns
RETENTION_OFFER_COST = 50.0          # cost of the retention offer, paid per contact
RETENTION_SUCCESS_RATE = 0.35        # P(save | true churner who is contacted)

# Analytical break-even probability for "make an offer":
#   act:      -(1 - s) * V * p - C          no-act: -V * p
#   act better  <=>  p > C / (s * V)
BREAK_EVEN_THRESHOLD = RETENTION_OFFER_COST / (
    RETENTION_SUCCESS_RATE * VALUE_OF_RETAINED_CUSTOMER
)

THRESHOLD_GRID = np.round(np.arange(0.05, 0.951, 0.01), 4)

# --------------------------------------------------------------------------- #
# Models / hyper-parameter search spaces
# --------------------------------------------------------------------------- #
N_ITER_SEARCH = 12          # default RandomizedSearchCV candidates per model family

# Per-family search budget (this box has 2 cores; budgets are tuned so that a
# full `make train` finishes in a few minutes while still exploring the space).
N_ITER_PER_MODEL: dict[str, int] = {
    "logistic_regression": 16,
    "random_forest": 12,
    "gradient_boosting": 8,
    "hist_gradient_boosting": 14,
    "stacking_ensemble": 4,
}
SEARCH_SCORING = {"roc_auc": "roc_auc", "average_precision": "average_precision"}
REFIT_METRIC = "roc_auc"
N_JOBS = -1

PARAM_GRIDS: dict[str, dict] = {
    "logistic_regression": {
        "clf__C": loguniform(1e-3, 1e2),
        # sklearn>=1.8: elastic-net mix is expressed via l1_ratio
        # (0 = ridge, 1 = lasso); `penalty` is deprecated.
        "clf__l1_ratio": [0.0, 0.15, 0.5, 0.85, 1.0],
        "clf__class_weight": [None, "balanced"],
    },
    "random_forest": {
        "clf__n_estimators": randint(200, 600),
        "clf__max_depth": randint(4, 20),
        "clf__min_samples_leaf": randint(2, 40),
        "clf__max_features": ["sqrt", "log2", 0.4],
        "clf__class_weight": [None, "balanced", "balanced_subsample"],
    },
    "hist_gradient_boosting": {
        "clf__learning_rate": loguniform(0.01, 0.3),
        "clf__max_iter": randint(150, 600),
        "clf__max_leaf_nodes": randint(8, 64),
        "clf__min_samples_leaf": randint(10, 80),
        "clf__l2_regularization": loguniform(1e-4, 10.0),
        "clf__max_features": uniform(0.5, 0.5),
    },
    "gradient_boosting": {
        "clf__learning_rate": loguniform(0.02, 0.3),
        "clf__n_estimators": randint(100, 400),
        "clf__max_depth": randint(2, 5),
        "clf__subsample": uniform(0.6, 0.4),
        "clf__min_samples_leaf": randint(10, 60),
    },
    # The stacking ensemble reuses the tuned base learners; only the
    # meta-learner is tuned.
    "stacking_ensemble": {
        "clf__final_estimator__C": loguniform(1e-3, 1e2),
        "clf__final_estimator__class_weight": [None, "balanced"],
    },
}

MODEL_ORDER = [
    "logistic_regression",
    "random_forest",
    "gradient_boosting",
    "hist_gradient_boosting",
    "stacking_ensemble",
]

# --------------------------------------------------------------------------- #
# Plotting
# --------------------------------------------------------------------------- #
FIG_DPI = 130
FIG_SIZE = (7.5, 5.0)
PALETTE = "deep"
