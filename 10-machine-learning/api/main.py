"""FastAPI churn-scoring service.

Endpoints
---------
GET  /health        liveness + whether the model is loaded
GET  /model-info    model name, version pins, threshold, features, metrics
POST /predict       one pydantic-validated customer record
POST /predict/batch a list of records (max 1000)

The joblib pipeline is loaded exactly once, at startup, via the lifespan hook.

Run:  uvicorn api.main:app --host 0.0.0.0 --port 8010
"""
from __future__ import annotations

import json
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import config  # noqa: E402
from src.data import SchemaError  # noqa: E402
from src.predict import load_metadata, load_model, score_frame  # noqa: E402

STATE: dict[str, object] = {"pipeline": None, "metadata": {}, "loaded_at": None}


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        STATE["pipeline"] = load_model()
        STATE["metadata"] = load_metadata()
        STATE["loaded_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        print(f"[startup] loaded {config.MODEL_PATH.name} "
              f"({STATE['metadata'].get('model_name')})")
    except FileNotFoundError as exc:  # keep /health useful even without a model
        print(f"[startup] WARNING: {exc}")
    yield
    STATE["pipeline"] = None


app = FastAPI(
    title="Customer Churn Prediction API",
    description=(
        "Scores telco-style customers for churn risk using the pipeline trained "
        "by `src/train.py`. Returns a calibrated-ish probability, a label at the "
        "cost-optimal threshold, and the top-3 contributing features."
    ),
    version="1.0.0",
    lifespan=lifespan,
)


# --------------------------------------------------------------------------- #
# schemas
# --------------------------------------------------------------------------- #
ContractType = Literal["Month-to-month", "One year", "Two year"]
PaymentMethod = Literal[
    "Electronic check", "Mailed check",
    "Bank transfer (automatic)", "Credit card (automatic)",
]
InternetService = Literal["DSL", "Fiber optic", "No internet service"]
Region = Literal["North", "South", "East", "West"]


class CustomerRecord(BaseModel):
    """One customer. Nullable numeric fields mirror the real data's missingness."""

    model_config = ConfigDict(extra="forbid", json_schema_extra={
        "example": {
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
    })

    customer_id: str | None = None
    tenure_months: Annotated[int, Field(ge=1, le=72)]
    monthly_charges: Annotated[float, Field(ge=15, le=200)]
    total_charges: Annotated[float | None, Field(ge=0, le=15_000)] = None
    contract_type: ContractType
    payment_method: PaymentMethod
    internet_service: InternetService | None = None
    num_support_tickets: Annotated[int, Field(ge=0, le=30)]
    avg_monthly_usage_gb: Annotated[float | None, Field(ge=0, le=2_000)] = None
    has_streaming: Annotated[int, Field(ge=0, le=1)]
    is_senior: Annotated[int, Field(ge=0, le=1)]
    num_dependents: Annotated[int | None, Field(ge=0, le=6)] = None
    region: Region
    last_login_days: Annotated[int | None, Field(ge=0, le=365)] = None
    churn_risk_score_v0: Annotated[float, Field(ge=0, le=100)] = 50.0
    account_flagged_for_review: Annotated[int, Field(ge=0, le=1)] = 0


class BatchRequest(BaseModel):
    records: Annotated[list[CustomerRecord], Field(min_length=1, max_length=1000)]
    threshold: Annotated[float | None, Field(gt=0, lt=1)] = None


class FeatureContribution(BaseModel):
    feature: str
    value: float
    contribution: float
    direction: str


class PredictionResponse(BaseModel):
    customer_id: str
    churn_probability: float
    churn_label: int
    prediction: str
    threshold: float
    risk_band: str
    top_features: list[FeatureContribution]
    explanation_method: str


class BatchResponse(BaseModel):
    n: int
    threshold: float
    predicted_churn_rate: float
    predictions: list[PredictionResponse]


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    model_name: str | None = None
    loaded_at: str | None = None
    api_version: str


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _require_model():
    if STATE["pipeline"] is None:
        raise HTTPException(
            status_code=503,
            detail="model not loaded - run `make train` and restart the service",
        )
    return STATE["pipeline"]


def _score(records: list[CustomerRecord], threshold: float | None) -> list[dict]:
    pipeline = _require_model()
    df = pd.DataFrame([r.model_dump() for r in records])
    try:
        return score_frame(df, pipeline=pipeline, threshold=threshold)
    except (SchemaError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# --------------------------------------------------------------------------- #
# routes
# --------------------------------------------------------------------------- #
@app.get("/health", response_model=HealthResponse, tags=["ops"])
def health() -> HealthResponse:
    loaded = STATE["pipeline"] is not None
    return HealthResponse(
        status="ok" if loaded else "degraded",
        model_loaded=loaded,
        model_name=STATE["metadata"].get("model_name") if loaded else None,
        loaded_at=STATE["loaded_at"],
        api_version=app.version,
    )


@app.get("/model-info", tags=["ops"])
def model_info() -> dict:
    _require_model()
    md = STATE["metadata"]
    return {
        "model_name": md.get("model_name"),
        "model_class": md.get("model_class"),
        "training_date": md.get("training_date"),
        "sklearn_version": md.get("sklearn_version"),
        "python_version": md.get("python_version"),
        "chosen_threshold": md.get("chosen_threshold"),
        "threshold_rule": md.get("threshold_rule"),
        "cost_matrix": md.get("cost_matrix"),
        "raw_feature_columns": md.get("raw_feature_columns"),
        "engineered_features": md.get("engineered_features"),
        "n_model_features": md.get("n_model_features"),
        "best_params": md.get("best_params"),
        "cv_metrics": md.get("cv_metrics"),
        "validation_metrics": md.get("validation_metrics"),
        "test_metrics": _test_metrics(),
        "loaded_at": STATE["loaded_at"],
    }


def _test_metrics() -> dict | None:
    if not config.TEST_METRICS_PATH.exists():
        return None
    m = json.loads(config.TEST_METRICS_PATH.read_text())
    return {k: m[k] for k in
            ("accuracy", "precision", "recall", "f1", "roc_auc", "pr_auc", "brier")
            if k in m}


@app.post("/predict", response_model=PredictionResponse, tags=["scoring"])
def predict(record: CustomerRecord) -> PredictionResponse:
    result = _score([record], None)[0]
    if record.customer_id:
        result["customer_id"] = record.customer_id
    return PredictionResponse(**result)


@app.post("/predict/batch", response_model=BatchResponse, tags=["scoring"])
def predict_batch(request: BatchRequest) -> BatchResponse:
    results = _score(request.records, request.threshold)
    for rec, res in zip(request.records, results):
        if rec.customer_id:
            res["customer_id"] = rec.customer_id
    return BatchResponse(
        n=len(results),
        threshold=results[0]["threshold"],
        predicted_churn_rate=sum(r["churn_label"] for r in results) / len(results),
        predictions=[PredictionResponse(**r) for r in results],
    )


@app.get("/", include_in_schema=False)
def root() -> dict:
    return {
        "service": app.title,
        "version": app.version,
        "docs": "/docs",
        "endpoints": ["/health", "/model-info", "/predict", "/predict/batch"],
    }
