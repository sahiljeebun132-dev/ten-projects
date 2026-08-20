"""Shared fixtures. Heavy artifacts (data, splits, model) are session-scoped."""
from __future__ import annotations

import sys
from pathlib import Path

import joblib
import pandas as pd
import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from src import config  # noqa: E402
from src.data import make_splits  # noqa: E402


@pytest.fixture(scope="session")
def raw_df() -> pd.DataFrame:
    if not config.RAW_DATA_PATH.exists():
        pytest.skip("data/churn.csv missing - run `make data`")
    return pd.read_csv(config.RAW_DATA_PATH)


@pytest.fixture(scope="session")
def splits():
    if not config.RAW_DATA_PATH.exists():
        pytest.skip("data/churn.csv missing - run `make data`")
    return make_splits()


@pytest.fixture(scope="session")
def model():
    if not config.MODEL_PATH.exists():
        pytest.skip("models/churn_model.joblib missing - run `make train`")
    return joblib.load(config.MODEL_PATH)


@pytest.fixture(scope="session")
def metadata() -> dict:
    import json

    if not config.METADATA_PATH.exists():
        pytest.skip("models/metadata.json missing - run `make train`")
    return json.loads(config.METADATA_PATH.read_text())


@pytest.fixture(scope="session")
def valid_record() -> dict:
    return {
        "customer_id": "CUST-TEST-1",
        "tenure_months": 3,
        "monthly_charges": 94.7,
        "total_charges": 271.5,
        "contract_type": "Month-to-month",
        "payment_method": "Electronic check",
        "internet_service": "Fiber optic",
        "num_support_tickets": 4,
        "avg_monthly_usage_gb": 61.2,
        "has_streaming": 1,
        "is_senior": 1,
        "num_dependents": 0,
        "region": "South",
        "last_login_days": 44,
        "churn_risk_score_v0": 51.3,
        "account_flagged_for_review": 0,
    }
