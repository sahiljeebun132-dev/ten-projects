"""Persisted model, metadata, threshold economics and the scoring helpers."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import Pipeline

from src import config
from src.explain import Explainer
from src.predict import records_to_frame, score_frame
from src.train import choose_threshold, expected_value, threshold_sweep


def test_model_is_a_pipeline_with_preprocessing(model):
    assert isinstance(model, Pipeline)
    assert "engineer" in model.named_steps
    assert "preprocess" in model.named_steps
    assert "clf" in model.named_steps


def test_model_predicts_valid_probabilities(model, splits):
    prob = model.predict_proba(splits.X_test)[:, 1]
    assert prob.shape == (len(splits.X_test),)
    assert ((prob >= 0.0) & (prob <= 1.0)).all()
    assert prob.std() > 0.05, "model outputs are nearly constant"


def test_model_beats_a_trivial_baseline(model, splits):
    auc = roc_auc_score(splits.y_test, model.predict_proba(splits.X_test)[:, 1])
    assert auc > 0.75, f"test ROC-AUC {auc:.3f} is below the acceptance bar"


def test_model_handles_rows_full_of_missing_values(model, splits):
    X = splits.X_test.head(5).copy()
    for col in ("total_charges", "avg_monthly_usage_gb", "last_login_days",
                "internet_service", "num_dependents"):
        X[col] = np.nan
    prob = model.predict_proba(X)[:, 1]
    assert np.isfinite(prob).all()


def test_metadata_contents(metadata):
    required = {
        "model_name", "sklearn_version", "training_date", "chosen_threshold",
        "model_feature_names", "cost_matrix", "cv_metrics", "validation_metrics",
        "best_params", "model_comparison",
    }
    assert required.issubset(metadata.keys())
    assert 0.0 < metadata["chosen_threshold"] < 1.0
    assert metadata["n_model_features"] == len(metadata["model_feature_names"])
    import sklearn

    assert metadata["sklearn_version"] == sklearn.__version__


def test_metadata_compares_all_model_families(metadata):
    compared = {row["model"] for row in metadata["model_comparison"]}
    assert compared == set(config.MODEL_ORDER)


def test_experiments_log_is_populated():
    assert config.EXPERIMENTS_PATH.exists()
    exp = pd.read_csv(config.EXPERIMENTS_PATH)
    assert len(exp) >= len(config.MODEL_ORDER)
    for col in ("model", "params", "cv_roc_auc_mean", "cv_pr_auc_mean"):
        assert col in exp.columns
    assert exp["cv_roc_auc_mean"].between(0.4, 1.0).all()


# --------------------------------------------------------------------------- #
# cost-sensitive threshold logic
# --------------------------------------------------------------------------- #
def test_expected_value_matches_hand_computation():
    y = np.array([1, 1, 0, 0])
    p = np.array([0.9, 0.1, 0.8, 0.2])
    ev = expected_value(y, p, 0.5)
    assert (ev["tp"], ev["fp"], ev["fn"], ev["tn"]) == (1, 1, 1, 1)
    V, C, s = (
        config.VALUE_OF_RETAINED_CUSTOMER,
        config.RETENTION_OFFER_COST,
        config.RETENTION_SUCCESS_RATE,
    )
    expected = 1 * (-C - (1 - s) * V) + 1 * (-C) + 1 * (-V)
    assert ev["expected_value"] == pytest.approx(expected)


def test_chosen_threshold_is_near_the_analytical_break_even(metadata):
    """The cost matrix implies p* = C / (s * V); the empirical optimum should agree."""
    assert metadata["chosen_threshold"] == pytest.approx(
        config.BREAK_EVEN_THRESHOLD, abs=0.12
    )


def test_threshold_beats_the_default_half(model, splits, metadata):
    prob = model.predict_proba(splits.X_test)[:, 1]
    y = splits.y_test.to_numpy()
    chosen = expected_value(y, prob, metadata["chosen_threshold"])["expected_value"]
    default = expected_value(y, prob, 0.5)["expected_value"]
    assert chosen >= default


def test_threshold_beats_contact_everyone_and_nobody(model, splits, metadata):
    prob = model.predict_proba(splits.X_test)[:, 1]
    ev = expected_value(splits.y_test.to_numpy(), prob, metadata["chosen_threshold"])
    assert ev["uplift_vs_do_nothing"] > 0
    assert ev["uplift_vs_contact_all"] > 0


def test_threshold_sweep_is_monotone_in_contact_rate(model, splits):
    prob = model.predict_proba(splits.X_test.head(1000))[:, 1]
    sweep = threshold_sweep(splits.y_test.head(1000).to_numpy(), prob)
    assert sweep["contact_rate"].is_monotonic_decreasing
    assert sweep["recall"].is_monotonic_decreasing
    best, _ = choose_threshold(splits.y_test.head(1000).to_numpy(), prob)
    assert 0.05 <= best <= 0.95


# --------------------------------------------------------------------------- #
# scoring helpers
# --------------------------------------------------------------------------- #
def test_score_frame_output_contract(model, splits, metadata):
    df = splits.X_test.head(4)
    results = score_frame(df, pipeline=model)
    assert len(results) == 4
    for r in results:
        assert 0.0 <= r["churn_probability"] <= 1.0
        assert r["churn_label"] in (0, 1)
        assert r["prediction"] in ("churn", "stay")
        assert r["threshold"] == pytest.approx(metadata["chosen_threshold"])
        assert len(r["top_features"]) == 3
        assert {"feature", "value", "contribution", "direction"} <= set(
            r["top_features"][0]
        )


def test_score_frame_respects_threshold_override(model, splits):
    df = splits.X_test.head(50)
    low = score_frame(df, pipeline=model, threshold=0.1, explain=False)
    high = score_frame(df, pipeline=model, threshold=0.9, explain=False)
    assert sum(r["churn_label"] for r in low) >= sum(r["churn_label"] for r in high)


def test_records_to_frame_rejects_incomplete_payload(valid_record):
    incomplete = {k: v for k, v in valid_record.items() if k != "tenure_months"}
    with pytest.raises(ValueError, match="missing required fields"):
        records_to_frame(incomplete)


def test_sample_input_file_scores(model):
    payload = json.loads(config.SAMPLE_INPUT_PATH.read_text())
    result = score_frame(records_to_frame(payload), pipeline=model)[0]
    assert 0.0 <= result["churn_probability"] <= 1.0


def test_explainer_contributions_shape(model, splits):
    explainer = Explainer(model)
    X = splits.X_test.head(6)
    contribs = explainer.contributions(X)
    assert contribs.shape[0] == len(X)
    assert contribs.shape[1] == len(explainer.feature_names)
    assert explainer.method in ("shap_tree", "shap_linear", "occlusion")


def test_high_risk_profile_scores_above_low_risk_profile(model, valid_record):
    """A textbook churner must out-score a textbook loyal customer."""
    loyal = dict(valid_record)
    loyal.update(
        tenure_months=68, monthly_charges=35.0, total_charges=2380.0,
        contract_type="Two year", payment_method="Bank transfer (automatic)",
        internet_service="DSL", num_support_tickets=0, avg_monthly_usage_gb=180.0,
        is_senior=0, num_dependents=3, last_login_days=2,
    )
    frame = records_to_frame([valid_record, loyal])
    scores = score_frame(frame, pipeline=model, explain=False)
    assert scores[0]["churn_probability"] > scores[1]["churn_probability"]
