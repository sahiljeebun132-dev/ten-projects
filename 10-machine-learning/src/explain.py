"""Per-row feature attributions used by the CLI and the API.

Strategy (in order of preference):

1. **SHAP** - ``TreeExplainer`` for forest/boosting models, ``LinearExplainer``
   for logistic regression. Exact and fast for those families.
2. **Occlusion fallback** - for models SHAP cannot handle cheaply (e.g. the
   stacking ensemble) each transformed feature is replaced, one at a time, by
   its background median and the change in predicted probability is recorded.
   Fully vectorised over rows, model-agnostic, and needs only ``predict_proba``.

Both paths return a signed contribution per transformed feature in the same
shape, so downstream code does not care which one ran.
"""
from __future__ import annotations

from dataclasses import dataclass

import joblib
import numpy as np
import pandas as pd

from . import config
from .features import get_feature_names

try:
    import shap

    SHAP_AVAILABLE = True
except Exception:  # pragma: no cover
    shap = None
    SHAP_AVAILABLE = False

_TREE_MODELS = (
    "RandomForestClassifier",
    "GradientBoostingClassifier",
    "HistGradientBoostingClassifier",
    "ExtraTreesClassifier",
    "DecisionTreeClassifier",
)


@dataclass
class Contribution:
    feature: str
    value: float
    contribution: float

    def as_dict(self) -> dict:
        return {
            "feature": self.feature,
            "value": round(float(self.value), 4),
            "contribution": round(float(self.contribution), 4),
            "direction": "increases churn risk" if self.contribution >= 0
            else "decreases churn risk",
        }


class Explainer:
    """Lazily-built explainer bound to a fitted pipeline."""

    def __init__(self, pipeline, background: np.ndarray | None = None):
        self.pipeline = pipeline
        self.model = pipeline.named_steps["clf"]
        self.pre = pipeline[:-1]
        self.feature_names = get_feature_names(pipeline)
        self.background = self._load_background(background)
        self.groups = self._build_groups()
        self.method = "unavailable"
        self._shap = None
        self._build()

    # ------------------------------------------------------------------ #
    @staticmethod
    def _load_background(background) -> np.ndarray | None:
        if background is not None:
            return np.asarray(background)
        if config.BACKGROUND_PATH.exists():
            blob = joblib.load(config.BACKGROUND_PATH)
            return np.asarray(blob["background"])
        return None

    def _build_groups(self) -> list[list[int]]:
        """Group the transformed columns that came from the same source feature.

        One-hot columns must be occluded together: zeroing a single dummy leaves
        the row in an impossible state ("no contract type at all") and badly
        understates the feature's true contribution.
        """
        index = {name: i for i, name in enumerate(self.feature_names)}
        groups: list[list[int]] = []
        used: set[int] = set()
        for col in config.MODEL_NUMERIC:
            if col in index:
                groups.append([index[col]])
                used.add(index[col])
        for col in config.MODEL_CATEGORICAL:
            members = [
                i for name, i in index.items()
                if name == col or name.startswith(f"{col}_")
            ]
            members = [i for i in members if i not in used]
            if members:
                groups.append(sorted(members))
                used.update(members)
        leftovers = [i for i in range(len(self.feature_names)) if i not in used]
        groups.extend([[i] for i in leftovers])
        return groups

    def _build(self) -> None:
        name = type(self.model).__name__
        if SHAP_AVAILABLE and name in _TREE_MODELS:
            try:
                self._shap = shap.TreeExplainer(self.model)
                self.method = "shap_tree"
                return
            except Exception:
                self._shap = None
        if SHAP_AVAILABLE and name == "LogisticRegression" and self.background is not None:
            try:
                self._shap = shap.LinearExplainer(self.model, self.background)
                self.method = "shap_linear"
                return
            except Exception:
                self._shap = None
        self.method = "occlusion"

    # ------------------------------------------------------------------ #
    def contributions(self, X: pd.DataFrame) -> np.ndarray:
        """(n_rows, n_features) signed contributions on the transformed matrix."""
        Xt = np.asarray(self.pre.transform(X), dtype=float)
        if self._shap is not None:
            try:
                values = self._shap.shap_values(Xt, check_additivity=False)
                arr = np.asarray(values)
                if arr.ndim == 3:            # (n, f, classes)
                    arr = arr[:, :, -1]
                elif arr.ndim == 1:
                    arr = arr.reshape(1, -1)
                return arr
            except Exception:
                self.method = "occlusion"
        return self._occlusion(Xt)

    def _occlusion(self, Xt: np.ndarray) -> np.ndarray:
        """Group-aware, distribution-aware occlusion.

        For each source feature we ask: *how much higher is this customer's churn
        probability than it would be if we knew nothing about that feature?*

        * numeric column -> reset to the background median;
        * one-hot group  -> replace by the **expectation over the background
          level frequencies** (each level is evaluated and the results are
          weighted). Substituting a single modal level instead would silently
          zero-out the contribution of every customer who already sits on that
          level, and zeroing a lone dummy would produce an impossible row.

        The change in P(churn) is attributed to the level that was active for
        that row. Cost: one ``predict_proba`` call per level, vectorised over
        all rows.
        """
        ref = self.background if self.background is not None else Xt
        baseline = np.median(ref, axis=0)
        p_full = self.model.predict_proba(Xt)[:, 1]
        out = np.zeros_like(Xt, dtype=float)

        for members in self.groups:
            if len(members) == 1:
                j = members[0]
                Xj = Xt.copy()
                Xj[:, j] = baseline[j]
                out[:, j] = p_full - self.model.predict_proba(Xj)[:, 1]
                continue

            freq = np.asarray(ref[:, members]).mean(axis=0)
            total = freq.sum()
            weights = freq / total if total > 0 else np.full(len(members),
                                                             1.0 / len(members))
            p_marginal = np.zeros(Xt.shape[0], dtype=float)
            for k, w in enumerate(weights):
                if w <= 0:
                    continue
                Xk = Xt.copy()
                block = np.zeros(len(members))
                block[k] = 1.0
                Xk[:, members] = block
                p_marginal += w * self.model.predict_proba(Xk)[:, 1]

            delta = p_full - p_marginal
            block = Xt[:, members]
            active = np.argmax(block, axis=1)
            has_active = block.max(axis=1) > 0
            rows = np.arange(Xt.shape[0])
            cols = np.where(has_active, np.asarray(members)[active], members[0])
            out[rows, cols] = delta
        return out

    # ------------------------------------------------------------------ #
    def top_features(self, X: pd.DataFrame, k: int = 3) -> list[list[dict]]:
        contribs = self.contributions(X)
        Xt = np.asarray(self.pre.transform(X), dtype=float)
        results: list[list[dict]] = []
        for i in range(contribs.shape[0]):
            order = np.argsort(-np.abs(contribs[i]))[:k]
            results.append(
                [
                    Contribution(
                        feature=self.feature_names[j],
                        value=Xt[i, j],
                        contribution=contribs[i, j],
                    ).as_dict()
                    for j in order
                ]
            )
        return results
