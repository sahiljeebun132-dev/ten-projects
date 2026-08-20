"""Collaborative filtering: item-item neighbourhood model + truncated-SVD factorisation."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy import sparse
from sklearn.decomposition import TruncatedSVD
from sklearn.metrics.pairwise import cosine_similarity

from .data_loader import load_ratings

DEFAULT_K = 15        # item-item neighbourhood size
DEFAULT_FACTORS = 8   # latent factors for the SVD model


@dataclass
class UserItemMatrix:
    """Sparse user x item rating matrix plus id <-> index mappings."""

    matrix: sparse.csr_matrix
    user_ids: np.ndarray
    movie_ids: np.ndarray
    user_index: dict[int, int]
    movie_index: dict[int, int]

    @property
    def shape(self) -> tuple[int, int]:
        return self.matrix.shape

    def has_user(self, user_id: int) -> bool:
        return int(user_id) in self.user_index

    def has_movie(self, movie_id: int) -> bool:
        return int(movie_id) in self.movie_index


def build_user_item_matrix(ratings: pd.DataFrame, movie_ids=None) -> UserItemMatrix:
    """Build the sparse rating matrix. ``movie_ids`` pins the column space to the catalogue."""
    users = np.sort(ratings["user_id"].unique())
    movies = np.sort(np.asarray(movie_ids)) if movie_ids is not None else np.sort(ratings["movie_id"].unique())
    user_index = {int(u): i for i, u in enumerate(users)}
    movie_index = {int(m): i for i, m in enumerate(movies)}

    keep = ratings["movie_id"].isin(movie_index)
    sub = ratings.loc[keep]
    rows = sub["user_id"].map(user_index).to_numpy()
    cols = sub["movie_id"].map(movie_index).to_numpy()
    vals = sub["rating"].to_numpy(dtype=np.float32)
    mat = sparse.csr_matrix((vals, (rows, cols)), shape=(len(users), len(movies)), dtype=np.float32)
    return UserItemMatrix(mat, users, movies, user_index, movie_index)


def _item_means(matrix: sparse.csr_matrix) -> np.ndarray:
    counts = np.diff(matrix.tocsc().indptr).astype(np.float32)
    sums = np.asarray(matrix.sum(axis=0)).ravel()
    global_mean = sums.sum() / max(matrix.nnz, 1)
    means = np.divide(sums, counts, out=np.full_like(sums, global_mean), where=counts > 0)
    return means.astype(np.float32)


def _user_means(matrix: sparse.csr_matrix) -> np.ndarray:
    counts = np.diff(matrix.indptr).astype(np.float32)
    sums = np.asarray(matrix.sum(axis=1)).ravel()
    global_mean = sums.sum() / max(matrix.nnz, 1)
    means = np.divide(sums, counts, out=np.full_like(sums, global_mean), where=counts > 0)
    return means.astype(np.float32)


def mean_centre(matrix: sparse.csr_matrix, means: np.ndarray, axis: int = 0) -> sparse.csr_matrix:
    """Subtract ``means`` from the *observed* entries only (missing stays missing)."""
    coo = matrix.tocoo()
    offset = means[coo.col] if axis == 0 else means[coo.row]
    data = coo.data - offset
    return sparse.csr_matrix((data, (coo.row, coo.col)), shape=matrix.shape, dtype=np.float32)


class _BaseCF:
    """Shared plumbing: fitting bookkeeping, seen items, ranking helpers."""

    ui: UserItemMatrix
    global_mean: float

    def _row(self, user_id: int) -> np.ndarray | None:
        if not self.ui.has_user(user_id):
            return None
        return self.ui.matrix[self.ui.user_index[int(user_id)]].toarray().ravel()

    def seen_items(self, user_id: int) -> np.ndarray:
        """movie_ids the user has already rated."""
        if not self.ui.has_user(user_id):
            return np.array([], dtype=int)
        row = self.ui.matrix[self.ui.user_index[int(user_id)]]
        return self.ui.movie_ids[row.indices]

    def predict_many(self, user_id: int, movie_ids) -> np.ndarray:
        return np.array([self.predict(user_id, int(m)) for m in movie_ids], dtype=float)

    def score_all(self, user_id: int) -> np.ndarray:  # pragma: no cover - overridden
        raise NotImplementedError

    def recommend(self, user_id: int, n: int = 10, exclude_seen: bool = True) -> pd.DataFrame:
        scores = self.score_all(user_id).astype(float)
        if exclude_seen and self.ui.has_user(user_id):
            row = self.ui.matrix[self.ui.user_index[int(user_id)]]
            scores[row.indices] = -np.inf
        order = np.argsort(-scores)[:n]
        order = [i for i in order if np.isfinite(scores[i])]
        return pd.DataFrame(
            {
                "rank": range(1, len(order) + 1),
                "movie_id": self.ui.movie_ids[order],
                "score": scores[order],
            }
        )


@dataclass
class ItemItemCF(_BaseCF):
    """Item-item neighbourhood CF on mean-centred ratings (adjusted cosine)."""

    k: int = DEFAULT_K
    shrinkage: float = 5.0
    ratings: pd.DataFrame | None = None
    movie_ids: object = None
    fitted: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        if self.ratings is not None:
            self.fit(self.ratings, self.movie_ids)

    def fit(self, ratings: pd.DataFrame | None = None, movie_ids=None) -> "ItemItemCF":
        ratings = load_ratings() if ratings is None else ratings
        self.ui = build_user_item_matrix(ratings, movie_ids if movie_ids is not None else self.movie_ids)
        mat = self.ui.matrix
        self.global_mean = float(mat.data.mean()) if mat.nnz else 3.5
        self.item_mean = _item_means(mat)
        self.user_mean = _user_means(mat)
        self.item_count = np.diff(mat.tocsc().indptr).astype(np.float32)

        # centre by user mean (adjusted cosine) so rater generosity cancels out
        centred = mean_centre(mat, self.user_mean, axis=1)
        self.centred = centred
        sim = cosine_similarity(centred.T.tocsr(), dense_output=True).astype(np.float32)
        np.fill_diagonal(sim, 0.0)

        # significance weighting: co-rating counts damp similarities from thin overlaps
        binary = (mat > 0).astype(np.float32)
        co = np.asarray((binary.T @ binary).todense(), dtype=np.float32)
        sim *= co / (co + self.shrinkage)
        np.fill_diagonal(sim, 0.0)
        self.similarity = sim
        self.fitted = True
        return self

    def _neighbour_mask(self, sim_row: np.ndarray) -> np.ndarray:
        if self.k >= sim_row.size:
            return np.arange(sim_row.size)
        return np.argpartition(-np.abs(sim_row), self.k)[: self.k]

    def predict(self, user_id: int, movie_id: int) -> float:
        """Predicted rating; falls back to item/user/global means for cold entries."""
        if not self.ui.has_movie(movie_id):
            return float(self.user_mean[self.ui.user_index[int(user_id)]]) if self.ui.has_user(user_id) else self.global_mean
        j = self.ui.movie_index[int(movie_id)]
        if not self.ui.has_user(user_id):
            return float(self.item_mean[j])
        u = self.ui.user_index[int(user_id)]
        row = self.centred[u]
        if row.nnz == 0:
            return float(self.item_mean[j])
        sims = self.similarity[j, row.indices]
        if sims.size > self.k:
            top = np.argpartition(-np.abs(sims), self.k)[: self.k]
            sims, vals = sims[top], row.data[top]
        else:
            vals = row.data
        denom = np.abs(sims).sum()
        base = float(self.user_mean[u])
        if denom < 1e-8:
            return float(np.clip(0.5 * (base + self.item_mean[j]), 0.5, 5.0))
        pred = base + float(np.dot(sims, vals) / denom)
        return float(np.clip(pred, 0.5, 5.0))

    def score_all(self, user_id: int) -> np.ndarray:
        if not self.ui.has_user(user_id):
            return self.item_mean.astype(float)
        u = self.ui.user_index[int(user_id)]
        row = self.centred[u]
        if row.nnz == 0:
            return self.item_mean.astype(float)
        sims = self.similarity[:, row.indices]          # (n_items, n_rated)
        num = sims @ row.data
        den = np.abs(sims).sum(axis=1)
        out = np.full(sims.shape[0], self.user_mean[u], dtype=float)
        ok = den > 1e-8
        out[ok] = self.user_mean[u] + num[ok] / den[ok]
        return np.clip(out, 0.5, 5.0)

    def similar_items(self, movie_id: int, n: int = 10) -> pd.DataFrame:
        j = self.ui.movie_index[int(movie_id)]
        sims = self.similarity[j].copy()
        order = np.argsort(-sims)[:n]
        return pd.DataFrame({"movie_id": self.ui.movie_ids[order], "similarity": sims[order]})


@dataclass
class SVDRecommender(_BaseCF):
    """Matrix factorisation via truncated SVD of the mean-centred rating matrix."""

    n_factors: int = DEFAULT_FACTORS
    random_state: int = 42
    ratings: pd.DataFrame | None = None
    movie_ids: object = None
    fitted: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        if self.ratings is not None:
            self.fit(self.ratings, self.movie_ids)

    def fit(self, ratings: pd.DataFrame | None = None, movie_ids=None) -> "SVDRecommender":
        ratings = load_ratings() if ratings is None else ratings
        self.ui = build_user_item_matrix(ratings, movie_ids if movie_ids is not None else self.movie_ids)
        mat = self.ui.matrix
        self.global_mean = float(mat.data.mean()) if mat.nnz else 3.5
        self.user_mean = _user_means(mat)
        self.item_mean = _item_means(mat)
        # baseline b_ui = mu + b_u + b_i, residuals are what the factors model
        self.user_bias = self.user_mean - self.global_mean
        self.item_bias = self.item_mean - self.global_mean

        coo = mat.tocoo()
        baseline = self.global_mean + self.user_bias[coo.row] + self.item_bias[coo.col]
        resid = sparse.csr_matrix((coo.data - baseline, (coo.row, coo.col)), shape=mat.shape, dtype=np.float32)

        k = int(min(self.n_factors, min(mat.shape) - 1))
        k = max(k, 1)
        self.n_components_ = k
        self.svd = TruncatedSVD(n_components=k, random_state=self.random_state)
        self.user_factors = self.svd.fit_transform(resid)            # U * S
        self.item_factors = self.svd.components_.T                   # V
        self.explained_variance_ratio_ = float(self.svd.explained_variance_ratio_.sum())
        self.fitted = True
        return self

    def _baseline(self, u: int | None, j: int | None) -> float:
        b = self.global_mean
        if u is not None:
            b += float(self.user_bias[u])
        if j is not None:
            b += float(self.item_bias[j])
        return b

    def predict(self, user_id: int, movie_id: int) -> float:
        has_u = self.ui.has_user(user_id)
        has_i = self.ui.has_movie(movie_id)
        u = self.ui.user_index[int(user_id)] if has_u else None
        j = self.ui.movie_index[int(movie_id)] if has_i else None
        pred = self._baseline(u, j)
        if has_u and has_i:
            pred += float(self.user_factors[u] @ self.item_factors[j])
        return float(np.clip(pred, 0.5, 5.0))

    def score_all(self, user_id: int) -> np.ndarray:
        if not self.ui.has_user(user_id):
            return np.clip(self.global_mean + self.item_bias, 0.5, 5.0).astype(float)
        u = self.ui.user_index[int(user_id)]
        pred = self.global_mean + self.user_bias[u] + self.item_bias + self.item_factors @ self.user_factors[u]
        return np.clip(pred, 0.5, 5.0).astype(float)

    def reconstruct(self) -> np.ndarray:
        """Dense rank-k reconstruction (small catalogue only -- used by the tests)."""
        return self.global_mean + self.user_bias[:, None] + self.item_bias[None, :] + self.user_factors @ self.item_factors.T


if __name__ == "__main__":  # pragma: no cover
    from .data_loader import load_data

    data = load_data()
    cf = ItemItemCF().fit(data.ratings, data.movies["movie_id"])
    svd = SVDRecommender().fit(data.ratings, data.movies["movie_id"])
    print("item-item:", cf.predict(1, 14), "svd:", svd.predict(1, 14))
