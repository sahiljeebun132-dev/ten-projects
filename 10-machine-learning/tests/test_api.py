"""FastAPI endpoint tests via fastapi.testclient (no server process required)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api.main import app
from src import config


@pytest.fixture(scope="module")
def client():
    if not config.MODEL_PATH.exists():
        pytest.skip("models/churn_model.joblib missing - run `make train`")
    with TestClient(app) as c:  # `with` triggers the lifespan/startup hook
        yield c


# --------------------------------------------------------------------------- #
def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["model_loaded"] is True
    assert body["model_name"]


def test_root_lists_endpoints(client):
    body = client.get("/").json()
    assert "/predict" in body["endpoints"]


def test_model_info(client, metadata):
    r = client.get("/model-info")
    assert r.status_code == 200
    body = r.json()
    assert body["model_name"] == metadata["model_name"]
    assert body["sklearn_version"] == metadata["sklearn_version"]
    assert body["chosen_threshold"] == pytest.approx(metadata["chosen_threshold"])
    assert body["cost_matrix"]["retention_offer_cost"] > 0
    assert len(body["raw_feature_columns"]) == len(config.FEATURE_COLUMNS)


def test_predict_single_record(client, valid_record):
    r = client.post("/predict", json=valid_record)
    assert r.status_code == 200, r.text
    body = r.json()
    assert 0.0 <= body["churn_probability"] <= 1.0
    assert body["churn_label"] in (0, 1)
    assert body["prediction"] in ("churn", "stay")
    assert body["customer_id"] == valid_record["customer_id"]
    assert len(body["top_features"]) == 3
    assert body["risk_band"] in ("very low", "low", "medium", "high")


def test_predict_accepts_nullable_fields(client, valid_record):
    payload = dict(valid_record)
    payload.update(
        total_charges=None, avg_monthly_usage_gb=None,
        last_login_days=None, internet_service=None, num_dependents=None,
    )
    r = client.post("/predict", json=payload)
    assert r.status_code == 200, r.text
    assert 0.0 <= r.json()["churn_probability"] <= 1.0


def test_predict_batch(client, valid_record):
    other = dict(valid_record, customer_id="CUST-TEST-2", tenure_months=60,
                 contract_type="Two year", num_support_tickets=0)
    r = client.post("/predict/batch",
                    json={"records": [valid_record, other], "threshold": 0.4})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n"] == 2
    assert body["threshold"] == pytest.approx(0.4)
    assert 0.0 <= body["predicted_churn_rate"] <= 1.0
    assert [p["customer_id"] for p in body["predictions"]] == [
        "CUST-TEST-1", "CUST-TEST-2"
    ]


# --------------------------------------------------------------------------- #
# validation errors -> 422
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "mutation",
    [
        {"contract_type": "Lifetime"},          # unknown category
        {"tenure_months": 0},                   # below the allowed range
        {"tenure_months": 500},                 # above the allowed range
        {"monthly_charges": -10},               # negative money
        {"has_streaming": 3},                   # not a 0/1 flag
        {"region": "Atlantis"},                 # unknown region
        {"tenure_months": "three"},             # wrong type
        {"unexpected_field": 1},                # extra="forbid"
    ],
)
def test_invalid_payloads_return_422(client, valid_record, mutation):
    payload = dict(valid_record, **mutation)
    r = client.post("/predict", json=payload)
    assert r.status_code == 422, f"{mutation} -> {r.status_code}"
    assert "detail" in r.json()


def test_missing_required_field_returns_422(client, valid_record):
    payload = {k: v for k, v in valid_record.items() if k != "contract_type"}
    r = client.post("/predict", json=payload)
    assert r.status_code == 422


def test_empty_batch_returns_422(client):
    r = client.post("/predict/batch", json={"records": []})
    assert r.status_code == 422


def test_batch_threshold_out_of_range_returns_422(client, valid_record):
    r = client.post("/predict/batch",
                    json={"records": [valid_record], "threshold": 1.5})
    assert r.status_code == 422
