"""Feature engineering + preprocessing, expressed entirely as an sklearn Pipeline.

Design rule: **nothing** is computed outside the pipeline. Every statistic that
depends on the data (imputation values, scaler moments, one-hot vocabularies and
the per-contract usage mean/std used by ``usage_z_by_contract``) is learned in
``fit`` and merely applied in ``transform``. That is what makes the no-leakage
test in ``tests/test_pipeline.py`` meaningful: fitting on train and transforming
test yields exactly the same numbers as transforming test rows one at a time.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from . import config

EPS = 1e-9


class FeatureEngineer(BaseEstimator, TransformerMixin):
    """Adds four domain features to the raw frame.

    ==================================  =======================================
    feature                             definition
    ==================================  =======================================
    ``charges_per_tenure_month``        total_charges / tenure_months - the
                                        realised average monthly spend, which
                                        differs from the *current* price for
                                        customers who were re-priced.
    ``tickets_per_tenure_year``         support tickets normalised by tenure -
                                        separates "noisy new joiner" from
                                        "chronically unhappy veteran".
    ``usage_z_by_contract``             usage standardised **within contract
                                        type** (group mean/std learned on the
                                        training fold only) - captures "low
                                        usage for someone on this plan".
    ``tenure_bucket``                   ordinal lifecycle bucket, one-hot
                                        encoded downstream; lets linear models
                                        express the non-linear tenure effect.
    ==================================  =======================================
    """

    def __init__(self, usage_col: str = "avg_monthly_usage_gb",
                 group_col: str = "contract_type"):
        self.usage_col = usage_col
        self.group_col = group_col

    # ------------------------------------------------------------------ #
    def fit(self, X: pd.DataFrame, y=None):
        X = self._as_frame(X)
        usage = np.log1p(X[self.usage_col].astype(float))
        grouped = usage.groupby(X[self.group_col].astype("object"), dropna=False)

        self.group_mean_ = grouped.mean().to_dict()
        self.group_std_ = grouped.std(ddof=0).to_dict()
        self.global_mean_ = float(usage.mean())
        self.global_std_ = float(usage.std(ddof=0))
        self.feature_names_in_ = np.asarray(X.columns, dtype=object)
        self.n_features_in_ = X.shape[1]
        return self

    def transform(self, X: pd.DataFrame) -> pd.DataFrame:
        X = self._as_frame(X).copy()
        self._check_fitted()

        tenure = X["tenure_months"].astype(float).clip(lower=1.0)

        X["charges_per_tenure_month"] = X["total_charges"].astype(float) / (tenure + EPS)
        X["tickets_per_tenure_year"] = (
            X["num_support_tickets"].astype(float) * 12.0 / (tenure + EPS)
        )

        usage = np.log1p(X[self.usage_col].astype(float))
        groups = X[self.group_col].astype("object")
        mu = groups.map(self.group_mean_).astype(float).fillna(self.global_mean_)
        sd = groups.map(self.group_std_).astype(float).fillna(self.global_std_)
        sd = sd.replace(0.0, np.nan).fillna(self.global_std_ or 1.0)
        X["usage_z_by_contract"] = (usage - mu) / (sd + EPS)

        X["tenure_bucket"] = pd.cut(
            X["tenure_months"].astype(float),
            bins=config.TENURE_BINS,
            labels=config.TENURE_LABELS,
            right=True,
            include_lowest=True,
        ).astype("object")

        return X

    # ------------------------------------------------------------------ #
    def get_feature_names_out(self, input_features=None) -> np.ndarray:
        base = list(input_features) if input_features is not None else list(
            getattr(self, "feature_names_in_", config.FEATURE_COLUMNS)
        )
        return np.asarray(
            base + config.ENGINEERED_NUMERIC + config.ENGINEERED_CATEGORICAL,
            dtype=object,
        )

    # ------------------------------------------------------------------ #
    @staticmethod
    def _as_frame(X) -> pd.DataFrame:
        if isinstance(X, pd.DataFrame):
            return X
        return pd.DataFrame(X, columns=config.FEATURE_COLUMNS)

    def _check_fitted(self) -> None:
        if not hasattr(self, "group_mean_"):
            raise RuntimeError("FeatureEngineer must be fitted before transform()")


# --------------------------------------------------------------------------- #
def build_preprocessor(scale_numeric: bool = True) -> ColumnTransformer:
    """ColumnTransformer: median-impute + scale numerics, mode-impute + OHE cats."""
    numeric_steps = [("imputer", SimpleImputer(strategy="median"))]
    if scale_numeric:
        numeric_steps.append(("scaler", StandardScaler()))
    numeric_pipe = Pipeline(numeric_steps)

    categorical_pipe = Pipeline(
        [
            ("imputer", SimpleImputer(strategy="most_frequent")),
            (
                "onehot",
                OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=1,
                              sparse_output=False),
            ),
        ]
    )

    return ColumnTransformer(
        transformers=[
            ("num", numeric_pipe, config.MODEL_NUMERIC),
            ("cat", categorical_pipe, config.MODEL_CATEGORICAL),
        ],
        remainder="drop",
        verbose_feature_names_out=False,
    )


def build_feature_pipeline(scale_numeric: bool = True) -> Pipeline:
    """The preprocessing half of the model pipeline (engineering + encoding)."""
    return Pipeline(
        [
            ("engineer", FeatureEngineer()),
            ("preprocess", build_preprocessor(scale_numeric=scale_numeric)),
        ]
    )


def build_model_pipeline(estimator, scale_numeric: bool = True) -> Pipeline:
    """Full pipeline: feature engineering -> preprocessing -> estimator (``clf``)."""
    pipe = build_feature_pipeline(scale_numeric=scale_numeric)
    return Pipeline(list(pipe.steps) + [("clf", estimator)])


def get_feature_names(pipeline: Pipeline) -> list[str]:
    """Names of the columns that reach the estimator, in order."""
    return list(pipeline.named_steps["preprocess"].get_feature_names_out())


if __name__ == "__main__":  # pragma: no cover - manual smoke check
    from .data import make_splits

    splits = make_splits()
    pipe = build_feature_pipeline()
    Xt = pipe.fit_transform(splits.X_train)
    print("train matrix:", Xt.shape, "NaNs:", int(np.isnan(Xt).sum()))
    print("features:", get_feature_names(pipe))
