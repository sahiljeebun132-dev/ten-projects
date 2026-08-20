"""Batch / single-record scoring CLI.

Examples
--------
    python -m src.predict --input data/sample_input.json
    python -m src.predict --csv data/sample_batch.csv --output reports/scored.csv
    python -m src.predict --csv data/churn.csv --limit 100 --threshold 0.4

Output per row: churn probability, label at the persisted operating threshold,
and the top-3 contributing features.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from . import config
from .data import coerce_types, validate_schema
from .explain import Explainer


# --------------------------------------------------------------------------- #
def load_model(model_path: Path = config.MODEL_PATH):
    if not model_path.exists():
        raise FileNotFoundError(f"{model_path} not found - run `make train` first.")
    return joblib.load(model_path)


def load_metadata(path: Path = config.METADATA_PATH) -> dict:
    if not path.exists():
        return {"chosen_threshold": 0.5}
    return json.loads(path.read_text())


def records_to_frame(records: list[dict] | dict) -> pd.DataFrame:
    if isinstance(records, dict):
        records = [records]
    df = pd.DataFrame(records)
    missing = [c for c in config.FEATURE_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"input is missing required fields: {missing}")
    keep = config.FEATURE_COLUMNS
    if config.ID_COLUMN in df.columns:  # keep the id so results stay traceable
        keep = [config.ID_COLUMN] + keep
    return df[keep]


def score_frame(
    df: pd.DataFrame,
    pipeline=None,
    threshold: float | None = None,
    *,
    explain: bool = True,
    top_k: int = 3,
) -> list[dict]:
    """Score a frame of raw feature rows and return JSON-ready dictionaries."""
    pipeline = pipeline or load_model()
    metadata = load_metadata()
    threshold = float(threshold if threshold is not None
                      else metadata.get("chosen_threshold", 0.5))

    ids = (
        df[config.ID_COLUMN].astype(str).tolist()
        if config.ID_COLUMN in df.columns
        else [f"row-{i}" for i in range(len(df))]
    )
    X = coerce_types(df[config.FEATURE_COLUMNS].copy())
    validate_schema(X)

    probs = pipeline.predict_proba(X)[:, 1]
    labels = (probs >= threshold).astype(int)

    top_features: list[list[dict]] = [[] for _ in range(len(X))]
    method = "none"
    if explain and len(X):
        explainer = Explainer(pipeline)
        top_features = explainer.top_features(X, k=top_k)
        method = explainer.method

    out = []
    for i in range(len(X)):
        out.append(
            {
                "customer_id": ids[i],
                "churn_probability": round(float(probs[i]), 6),
                "churn_label": int(labels[i]),
                "prediction": "churn" if labels[i] else "stay",
                "threshold": threshold,
                "risk_band": _risk_band(float(probs[i]), threshold),
                "top_features": top_features[i],
                "explanation_method": method,
            }
        )
    return out


def _risk_band(p: float, threshold: float) -> str:
    if p >= max(0.6, threshold + 0.2):
        return "high"
    if p >= threshold:
        return "medium"
    if p >= threshold / 2:
        return "low"
    return "very low"


# --------------------------------------------------------------------------- #
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Score customers for churn risk.")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--input", type=Path,
                     help="JSON file: one record object or a list of records.")
    src.add_argument("--csv", type=Path, help="CSV file for batch scoring.")
    parser.add_argument("--output", type=Path, default=None,
                        help="Write results to this path (.csv or .json).")
    parser.add_argument("--threshold", type=float, default=None,
                        help="Override the persisted operating threshold.")
    parser.add_argument("--limit", type=int, default=None,
                        help="Only score the first N rows of a CSV.")
    parser.add_argument("--no-explain", action="store_true",
                        help="Skip per-row feature attributions (faster).")
    args = parser.parse_args(argv)

    if args.input:
        payload = json.loads(Path(args.input).read_text())
        df = records_to_frame(payload)
    else:
        df = pd.read_csv(args.csv)
        if args.limit:
            df = df.head(args.limit)

    results = score_frame(df, threshold=args.threshold, explain=not args.no_explain)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        if args.output.suffix == ".csv":
            flat = []
            for r in results:
                row = {k: v for k, v in r.items() if k != "top_features"}
                for n, feat in enumerate(r["top_features"], start=1):
                    row[f"top{n}_feature"] = feat["feature"]
                    row[f"top{n}_contribution"] = feat["contribution"]
                flat.append(row)
            pd.DataFrame(flat).to_csv(args.output, index=False)
        else:
            args.output.write_text(json.dumps(results, indent=2) + "\n")
        print(f"wrote {len(results)} scored rows -> {args.output}")
    else:
        print(json.dumps(results if len(results) > 1 else results[0], indent=2))

    if len(results) > 1:
        rate = float(np.mean([r["churn_label"] for r in results]))
        print(f"\n{len(results)} rows scored | flagged as churn risk: {rate:.1%} "
              f"| threshold {results[0]['threshold']:.2f}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
