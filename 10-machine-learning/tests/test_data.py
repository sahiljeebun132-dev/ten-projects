"""Dataset generation, schema validation and splitting."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from sklearn.metrics import roc_auc_score

from src import config
from src.data import SchemaError, class_balance, make_splits, validate_schema

import importlib.util

_spec = importlib.util.spec_from_file_location(
    "generate_data", config.DATA_DIR / "generate_data.py"
)
generate_data = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(generate_data)


# --------------------------------------------------------------------------- #
# determinism
# --------------------------------------------------------------------------- #
def test_generation_is_deterministic():
    a = generate_data.generate(n_rows=1200, seed=config.RANDOM_SEED)
    b = generate_data.generate(n_rows=1200, seed=config.RANDOM_SEED)
    pd.testing.assert_frame_equal(a, b)


def test_generation_changes_with_seed():
    a = generate_data.generate(n_rows=1200, seed=config.RANDOM_SEED)
    b = generate_data.generate(n_rows=1200, seed=config.RANDOM_SEED + 1)
    assert not a["churn"].equals(b["churn"])


def test_committed_csv_matches_generator(raw_df):
    """The CSV in the repo is exactly what the committed generator produces."""
    regenerated = generate_data.generate()
    assert len(regenerated) == len(raw_df)
    pd.testing.assert_series_equal(
        regenerated["churn"], raw_df["churn"], check_dtype=False
    )
    np.testing.assert_allclose(
        regenerated["monthly_charges"].to_numpy(),
        raw_df["monthly_charges"].to_numpy(),
        rtol=1e-9,
    )


# --------------------------------------------------------------------------- #
# dataset shape / realism
# --------------------------------------------------------------------------- #
def test_dataset_shape_and_columns(raw_df):
    assert len(raw_df) == config.N_ROWS
    # the CSV keeps the generator's human-friendly column order; the modelling
    # code addresses columns by name, so compare as sets
    assert set(raw_df.columns) == set(config.ALL_COLUMNS)
    assert raw_df[config.ID_COLUMN].is_unique


def test_target_imbalance_is_realistic(raw_df):
    rate = raw_df[config.TARGET].mean()
    assert 0.23 < rate < 0.29, f"churn rate {rate:.3f} outside the intended band"


def test_missing_values_are_present_but_bounded(raw_df):
    miss = raw_df.isna().mean()
    assert miss["total_charges"] > 0.01
    assert miss["avg_monthly_usage_gb"] > 0.01
    assert miss["last_login_days"] > 0.01
    assert miss["internet_service"] > 0.0
    assert raw_df[config.TARGET].isna().sum() == 0
    assert miss.max() < 0.15


def test_red_herrings_carry_no_signal(raw_df):
    """Columns that *look* leaky must be statistically independent of the target."""
    y = raw_df[config.TARGET]
    for col in config.RED_HERRING_FEATURES:
        auc = roc_auc_score(y, raw_df[col].fillna(0))
        assert 0.47 < auc < 0.53, f"{col} leaks signal (AUC={auc:.3f})"


def test_no_perfect_predictor_exists(raw_df):
    """Guards against an accidental leak in the generator."""
    y = raw_df[config.TARGET]
    for col in config.NUMERIC_FEATURES:
        auc = roc_auc_score(y, raw_df[col].fillna(raw_df[col].median()))
        assert auc < 0.95, f"{col} is a near-perfect predictor (AUC={auc:.3f})"


# --------------------------------------------------------------------------- #
# schema validation
# --------------------------------------------------------------------------- #
def test_validate_schema_accepts_valid_frame(raw_df):
    assert validate_schema(raw_df, require_target=True) is raw_df


def test_validate_schema_rejects_missing_column(raw_df):
    with pytest.raises(SchemaError, match="missing required feature columns"):
        validate_schema(raw_df.drop(columns=["tenure_months"]))


def test_validate_schema_rejects_unknown_category(raw_df):
    bad = raw_df.copy()
    bad.loc[bad.index[0], "contract_type"] = "Lifetime"
    with pytest.raises(SchemaError, match="unexpected levels"):
        validate_schema(bad)


def test_validate_schema_rejects_out_of_range(raw_df):
    bad = raw_df.copy()
    bad.loc[bad.index[0], "tenure_months"] = 900
    with pytest.raises(SchemaError, match="out of range"):
        validate_schema(bad)


def test_validate_schema_rejects_non_binary_target(raw_df):
    bad = raw_df.copy()
    bad.loc[bad.index[0], config.TARGET] = 7
    with pytest.raises(SchemaError, match="binary"):
        validate_schema(bad, require_target=True)


# --------------------------------------------------------------------------- #
# splitting
# --------------------------------------------------------------------------- #
def test_splits_are_stratified_and_sized(splits):
    total = len(splits.y_train) + len(splits.y_val) + len(splits.y_test)
    assert total == config.N_ROWS
    assert len(splits.y_test) == pytest.approx(config.N_ROWS * config.TEST_SIZE, abs=2)
    assert len(splits.y_val) == pytest.approx(config.N_ROWS * config.VAL_SIZE, abs=2)
    rates = [splits.y_train.mean(), splits.y_val.mean(), splits.y_test.mean()]
    assert max(rates) - min(rates) < 0.01


def test_splits_are_disjoint(splits):
    idx_train = set(splits.X_train.index)
    idx_val = set(splits.X_val.index)
    idx_test = set(splits.X_test.index)
    assert not (idx_train & idx_val)
    assert not (idx_train & idx_test)
    assert not (idx_val & idx_test)


def test_splits_are_reproducible():
    a, b = make_splits(), make_splits()
    pd.testing.assert_frame_equal(a.X_test, b.X_test)


def test_class_balance_helper(splits):
    cb = class_balance(splits.y_train)
    assert cb["positives"] + cb["negatives"] == cb["n"]
    assert 2.0 < cb["imbalance_ratio"] < 4.0
