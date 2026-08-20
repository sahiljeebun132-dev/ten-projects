"""Data loading, schema validation and stratified splitting."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split

from . import config


class SchemaError(ValueError):
    """Raised when an input frame does not satisfy the expected contract."""


@dataclass(frozen=True)
class Splits:
    """Container for the 60/20/20 stratified split."""

    X_train: pd.DataFrame
    y_train: pd.Series
    X_val: pd.DataFrame
    y_val: pd.Series
    X_test: pd.DataFrame
    y_test: pd.Series

    @property
    def X_trainval(self) -> pd.DataFrame:
        return pd.concat([self.X_train, self.X_val], axis=0)

    @property
    def y_trainval(self) -> pd.Series:
        return pd.concat([self.y_train, self.y_val], axis=0)

    def summary(self) -> pd.DataFrame:
        rows = []
        for name in ("train", "val", "test"):
            y = getattr(self, f"y_{name}")
            rows.append(
                {"split": name, "rows": len(y), "churn_rate": round(float(y.mean()), 4)}
            )
        return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# loading / validation
# --------------------------------------------------------------------------- #
def load_raw(path: Path | str = config.RAW_DATA_PATH) -> pd.DataFrame:
    """Load the churn CSV, failing loudly if the generator has not been run."""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(
            f"{path} not found - run `python data/generate_data.py` (or `make data`) first."
        )
    df = pd.read_csv(path)
    validate_schema(df, require_target=True)
    return df


def validate_schema(df: pd.DataFrame, *, require_target: bool = False,
                    strict_ranges: bool = True) -> pd.DataFrame:
    """Validate columns, dtypes, category levels and numeric ranges.

    Used by ``load_raw`` and by the scoring paths (CLI + API) so that a bad
    payload fails with a clear message instead of a silent mis-prediction.
    """
    missing = [c for c in config.FEATURE_COLUMNS if c not in df.columns]
    if missing:
        raise SchemaError(f"missing required feature columns: {missing}")
    if require_target and config.TARGET not in df.columns:
        raise SchemaError(f"missing target column '{config.TARGET}'")

    if require_target:
        bad = set(pd.unique(df[config.TARGET].dropna())) - {0, 1}
        if bad:
            raise SchemaError(f"target must be binary 0/1, found {sorted(bad)}")
        if df[config.TARGET].isna().any():
            raise SchemaError("target column contains missing values")

    for col in config.NUMERIC_FEATURES:
        if not pd.api.types.is_numeric_dtype(df[col]):
            raise SchemaError(f"column '{col}' must be numeric, got {df[col].dtype}")
        if strict_ranges:
            lo, hi = config.NUMERIC_RANGES[col]
            series = df[col].dropna()
            if len(series) and (series.min() < lo or series.max() > hi):
                raise SchemaError(
                    f"column '{col}' out of range [{lo}, {hi}]: "
                    f"observed [{series.min()}, {series.max()}]"
                )

    for col, levels in config.CATEGORY_LEVELS.items():
        observed = set(pd.unique(df[col].dropna()))
        # numeric flags may arrive as floats after a round-trip through JSON
        observed = {int(v) if isinstance(v, (int, float, np.integer, np.floating))
                    and float(v).is_integer() else v for v in observed}
        unknown = observed - set(levels)
        if unknown:
            raise SchemaError(
                f"column '{col}' contains unexpected levels {sorted(map(str, unknown))}; "
                f"allowed: {levels}"
            )
    return df


def coerce_types(df: pd.DataFrame) -> pd.DataFrame:
    """Best-effort dtype coercion for payloads arriving from JSON/CSV.

    A single JSON record with ``"total_charges": null`` produces an *object*
    column in pandas; without this the schema check would reject a perfectly
    legal request. Non-numeric junk becomes NaN and is then handled by the
    pipeline's imputers.
    """
    df = df.copy()
    for col in config.NUMERIC_FEATURES:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    for col in ("has_streaming", "is_senior", "account_flagged_for_review"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")
    # JSON nulls arrive as ``None``; sklearn's SimpleImputer only recognises
    # ``np.nan`` inside object arrays, so normalise them explicitly.
    for col in ("contract_type", "payment_method", "internet_service", "region"):
        if col in df.columns:
            col_obj = df[col].astype("object")
            df[col] = col_obj.where(col_obj.notna(), np.nan)
    return df


def split_xy(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Split a labelled frame into the modelling matrix and the target."""
    X = df[config.FEATURE_COLUMNS].copy()
    y = df[config.TARGET].astype(int).copy()
    return X, y


def make_splits(
    df: pd.DataFrame | None = None,
    *,
    test_size: float = config.TEST_SIZE,
    val_size: float = config.VAL_SIZE,
    seed: int = config.RANDOM_SEED,
) -> Splits:
    """Stratified 60/20/20 train/val/test split.

    The test set is carved out first and never touched again until
    ``src/evaluate.py`` runs.
    """
    if df is None:
        df = load_raw()
    X, y = split_xy(df)

    X_trainval, X_test, y_trainval, y_test = train_test_split(
        X, y, test_size=test_size, stratify=y, random_state=seed
    )
    # val_size is expressed as a fraction of the *full* dataset
    rel_val = val_size / (1.0 - test_size)
    X_train, X_val, y_train, y_val = train_test_split(
        X_trainval, y_trainval, test_size=rel_val, stratify=y_trainval, random_state=seed
    )
    return Splits(X_train, y_train, X_val, y_val, X_test, y_test)


def class_balance(y: pd.Series) -> dict[str, float]:
    counts = y.value_counts().to_dict()
    return {
        "n": int(len(y)),
        "positives": int(counts.get(1, 0)),
        "negatives": int(counts.get(0, 0)),
        "churn_rate": float(y.mean()),
        "imbalance_ratio": float(counts.get(0, 0) / max(counts.get(1, 1), 1)),
    }


if __name__ == "__main__":  # pragma: no cover - manual smoke check
    splits = make_splits()
    print(splits.summary().to_string(index=False))
    print(class_balance(splits.y_train))
