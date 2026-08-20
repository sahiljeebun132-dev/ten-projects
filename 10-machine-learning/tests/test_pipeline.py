"""Feature engineering + preprocessing behaviour, including leakage checks."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from sklearn.linear_model import LogisticRegression

from src import config
from src.features import (
    FeatureEngineer,
    build_feature_pipeline,
    build_model_pipeline,
    get_feature_names,
)


# --------------------------------------------------------------------------- #
# engineered features
# --------------------------------------------------------------------------- #
def test_engineer_adds_expected_columns(splits):
    fe = FeatureEngineer().fit(splits.X_train)
    out = fe.transform(splits.X_train)
    for col in config.ENGINEERED_NUMERIC + config.ENGINEERED_CATEGORICAL:
        assert col in out.columns
    assert len(out) == len(splits.X_train)
    assert list(out.columns) == list(fe.get_feature_names_out(splits.X_train.columns))


def test_engineered_values_are_correct(splits):
    fe = FeatureEngineer().fit(splits.X_train)
    out = fe.transform(splits.X_train)
    row = out.iloc[0]
    tenure = max(float(row["tenure_months"]), 1.0)

    if not pd.isna(row["total_charges"]):
        assert row["charges_per_tenure_month"] == pytest.approx(
            row["total_charges"] / tenure, rel=1e-6
        )
    assert row["tickets_per_tenure_year"] == pytest.approx(
        row["num_support_tickets"] * 12.0 / tenure, rel=1e-6
    )
    assert row["tenure_bucket"] in config.TENURE_LABELS


def test_usage_z_by_contract_is_standardised_within_group(splits):
    fe = FeatureEngineer().fit(splits.X_train)
    out = fe.transform(splits.X_train)
    grouped = out.groupby("contract_type", observed=True)["usage_z_by_contract"]
    assert grouped.mean().abs().max() < 0.05
    assert (grouped.std().dropna() - 1.0).abs().max() < 0.1


def test_transform_without_fit_raises(splits):
    with pytest.raises(RuntimeError):
        FeatureEngineer().transform(splits.X_train)


# --------------------------------------------------------------------------- #
# preprocessing output
# --------------------------------------------------------------------------- #
def test_pipeline_output_has_no_nans(splits):
    pipe = build_feature_pipeline().fit(splits.X_train)
    for X in (splits.X_train, splits.X_val, splits.X_test):
        arr = np.asarray(pipe.transform(X), dtype=float)
        assert not np.isnan(arr).any(), "NaNs survived the preprocessing pipeline"
        assert np.isfinite(arr).all()


def test_pipeline_shapes_and_feature_names(splits):
    pipe = build_feature_pipeline().fit(splits.X_train)
    names = get_feature_names(pipe)
    train_t = pipe.transform(splits.X_train)
    test_t = pipe.transform(splits.X_test)

    assert train_t.shape == (len(splits.X_train), len(names))
    assert test_t.shape == (len(splits.X_test), len(names))
    assert len(set(names)) == len(names)
    for col in config.ENGINEERED_NUMERIC:
        assert col in names
    assert any(n.startswith("tenure_bucket_") for n in names)


def test_numeric_features_are_scaled_on_train(splits):
    pipe = build_feature_pipeline().fit(splits.X_train)
    arr = np.asarray(pipe.transform(splits.X_train))
    n_numeric = len(config.MODEL_NUMERIC)
    numeric_block = arr[:, :n_numeric]
    assert np.abs(numeric_block.mean(axis=0)).max() < 1e-8
    assert np.abs(numeric_block.std(axis=0) - 1.0).max() < 1e-6


# --------------------------------------------------------------------------- #
# leakage checks
# --------------------------------------------------------------------------- #
def test_imputer_and_scaler_statistics_come_from_train_only(splits):
    """Statistics learned on train must equal train-only statistics."""
    pipe = build_feature_pipeline().fit(splits.X_train)
    ct = pipe.named_steps["preprocess"]
    num_pipe = ct.named_transformers_["num"]

    engineered_train = pipe.named_steps["engineer"].transform(splits.X_train)
    expected_median = engineered_train[config.MODEL_NUMERIC].median().to_numpy()
    np.testing.assert_allclose(
        num_pipe.named_steps["imputer"].statistics_, expected_median, rtol=1e-9
    )

    # ...and must differ from the statistics of the full dataset, which proves
    # the test rows never influenced them.
    full = pd.concat([splits.X_train, splits.X_val, splits.X_test])
    engineered_full = pipe.named_steps["engineer"].transform(full)
    full_median = engineered_full[config.MODEL_NUMERIC].median().to_numpy()
    assert not np.allclose(
        num_pipe.named_steps["imputer"].statistics_, full_median, rtol=1e-12
    )


def test_group_statistics_are_fit_on_train_only(splits):
    fe_train = FeatureEngineer().fit(splits.X_train)
    fe_all = FeatureEngineer().fit(
        pd.concat([splits.X_train, splits.X_val, splits.X_test])
    )
    assert fe_train.group_mean_.keys() == fe_all.group_mean_.keys()
    assert any(
        abs(fe_train.group_mean_[k] - fe_all.group_mean_[k]) > 1e-9
        for k in fe_train.group_mean_
    ), "usage z-score group means look like they were fit on the full dataset"


def test_transform_is_row_independent(splits):
    """Scoring one row at a time equals batch scoring - no cross-row information."""
    pipe = build_feature_pipeline().fit(splits.X_train)
    sample = splits.X_test.head(12)
    batch = np.asarray(pipe.transform(sample))
    one_by_one = np.vstack(
        [np.asarray(pipe.transform(sample.iloc[[i]])) for i in range(len(sample))]
    )
    np.testing.assert_allclose(batch, one_by_one, rtol=1e-9, atol=1e-9)


def test_refitting_on_test_changes_the_matrix(splits):
    """Sanity check that the leakage test above is not vacuous."""
    fitted_on_train = build_feature_pipeline().fit(splits.X_train)
    fitted_on_test = build_feature_pipeline().fit(splits.X_test)
    a = np.asarray(fitted_on_train.transform(splits.X_test))
    b = np.asarray(fitted_on_test.transform(splits.X_test))
    assert not np.allclose(a, b)


# --------------------------------------------------------------------------- #
# end-to-end pipeline
# --------------------------------------------------------------------------- #
def test_model_pipeline_fits_and_predicts(splits):
    pipe = build_model_pipeline(
        LogisticRegression(max_iter=1000, random_state=config.RANDOM_SEED)
    )
    pipe.fit(splits.X_train.head(2000), splits.y_train.head(2000))
    prob = pipe.predict_proba(splits.X_val.head(200))[:, 1]
    assert prob.shape == (200,)
    assert ((prob >= 0) & (prob <= 1)).all()


def test_pipeline_handles_unseen_category_gracefully(splits):
    pipe = build_feature_pipeline().fit(splits.X_train)
    weird = splits.X_test.head(3).copy()
    weird.loc[:, "region"] = "Antarctica"
    arr = np.asarray(pipe.transform(weird), dtype=float)
    assert not np.isnan(arr).any()
