"""Offline evaluation: rating-prediction error and ranking quality for every model."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .collaborative import ItemItemCF, SVDRecommender
from .content_based import ContentBasedRecommender
from .data_loader import MovieData, load_data
from .hybrid import HybridRecommender, _minmax, weighted_rating

SEED = 42
TEST_FRACTION = 0.2
K = 10
RELEVANT_THRESHOLD = 4.0
MIN_TRAIN_RATINGS = 5


# --------------------------------------------------------------------- split
def train_test_split_ratings(
    ratings: pd.DataFrame,
    test_fraction: float = TEST_FRACTION,
    seed: int = SEED,
    min_train: int = MIN_TRAIN_RATINGS,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Per-user random hold-out so every user keeps a training profile."""
    rng = np.random.default_rng(seed)
    train_parts, test_parts = [], []
    for _, group in ratings.groupby("user_id", sort=False):
        idx = rng.permutation(len(group))
        n_test = int(round(len(group) * test_fraction))
        n_test = min(n_test, max(len(group) - min_train, 0))
        test_parts.append(group.iloc[idx[:n_test]])
        train_parts.append(group.iloc[idx[n_test:]])
    train = pd.concat(train_parts).sort_index()
    test = pd.concat(test_parts).sort_index()
    return train.reset_index(drop=True), test.reset_index(drop=True)


# ------------------------------------------------------------------ metrics
def rmse(y_true, y_pred) -> float:
    y_true, y_pred = np.asarray(y_true, float), np.asarray(y_pred, float)
    return float(np.sqrt(np.mean((y_true - y_pred) ** 2)))


def mae(y_true, y_pred) -> float:
    y_true, y_pred = np.asarray(y_true, float), np.asarray(y_pred, float)
    return float(np.mean(np.abs(y_true - y_pred)))


def precision_at_k(recommended: list[int], relevant: set[int], k: int = K) -> float:
    if k == 0:
        return 0.0
    top = recommended[:k]
    return len([i for i in top if i in relevant]) / k


def recall_at_k(recommended: list[int], relevant: set[int], k: int = K) -> float:
    if not relevant:
        return 0.0
    top = recommended[:k]
    return len([i for i in top if i in relevant]) / len(relevant)


def average_precision_at_k(recommended: list[int], relevant: set[int], k: int = K) -> float:
    """AP@K -- precision at each hit, averaged over min(|relevant|, K)."""
    if not relevant:
        return 0.0
    hits, score = 0, 0.0
    for rank, item in enumerate(recommended[:k], start=1):
        if item in relevant:
            hits += 1
            score += hits / rank
    return score / min(len(relevant), k)


# ------------------------------------------------------------------ models
@dataclass
class RankingResult:
    name: str
    precision: float
    recall: float
    map_score: float
    coverage: float
    n_users: int


class GlobalMeanBaseline:
    """mu + b_u + b_i -- the baseline any real model has to beat."""

    def fit(self, train: pd.DataFrame) -> "GlobalMeanBaseline":
        self.mu = float(train["rating"].mean())
        self.b_u = (train.groupby("user_id")["rating"].mean() - self.mu).to_dict()
        self.b_i = (train.groupby("movie_id")["rating"].mean() - self.mu).to_dict()
        return self

    def predict(self, user_id: int, movie_id: int) -> float:
        return float(np.clip(self.mu + self.b_u.get(int(user_id), 0.0) + self.b_i.get(int(movie_id), 0.0), 0.5, 5.0))

    def predict_many(self, user_id, movie_ids):
        return np.array([self.predict(user_id, m) for m in movie_ids])


def evaluate_rating_predictors(models: dict[str, object], test: pd.DataFrame) -> pd.DataFrame:
    rows = []
    users = test["user_id"].to_numpy()
    items = test["movie_id"].to_numpy()
    truth = test["rating"].to_numpy(dtype=float)
    for name, model in models.items():
        preds = np.array([model.predict(int(u), int(i)) for u, i in zip(users, items)], dtype=float)
        rows.append({"model": name, "RMSE": rmse(truth, preds), "MAE": mae(truth, preds), "n_predictions": len(truth)})
    return pd.DataFrame(rows)


def evaluate_rankers(
    scorers: dict[str, "callable"],
    train: pd.DataFrame,
    test: pd.DataFrame,
    movie_ids: np.ndarray,
    k: int = K,
    threshold: float = RELEVANT_THRESHOLD,
) -> pd.DataFrame:
    """Score every candidate movie per user, cut at K and compute ranking metrics."""
    train_by_user = {u: set(g["movie_id"]) for u, g in train.groupby("user_id")}
    relevant_by_user = {
        u: set(g.loc[g["rating"] >= threshold, "movie_id"])
        for u, g in test.groupby("user_id")
    }
    eval_users = [u for u, rel in relevant_by_user.items() if rel]

    rows = []
    for name, scorer in scorers.items():
        precisions, recalls, aps = [], [], []
        recommended_pool: set[int] = set()
        for user in eval_users:
            scores = np.asarray(scorer(user), dtype=float).copy()
            seen = train_by_user.get(user, set())
            if seen:
                scores[np.isin(movie_ids, list(seen))] = -np.inf
            order = np.argsort(-scores)[:k]
            top = [int(movie_ids[i]) for i in order if np.isfinite(scores[i])]
            recommended_pool.update(top)
            rel = relevant_by_user[user]
            precisions.append(precision_at_k(top, rel, k))
            recalls.append(recall_at_k(top, rel, k))
            aps.append(average_precision_at_k(top, rel, k))
        rows.append(
            {
                "model": name,
                f"Precision@{k}": float(np.mean(precisions)),
                f"Recall@{k}": float(np.mean(recalls)),
                f"MAP@{k}": float(np.mean(aps)),
                "Coverage": len(recommended_pool) / len(movie_ids),
                "users": len(eval_users),
            }
        )
    return pd.DataFrame(rows)


def _table(df: pd.DataFrame, floatfmt: str = "{:.4f}") -> str:
    """Small dependency-free table renderer."""
    cols = list(df.columns)
    cells = [[c if isinstance(c, str) else (floatfmt.format(c) if isinstance(c, float) else str(c)) for c in row]
             for row in df.itertuples(index=False)]
    widths = [max(len(str(cols[i])), *(len(row[i]) for row in cells)) for i in range(len(cols))]
    sep = "-+-".join("-" * w for w in widths)
    head = " | ".join(str(c).ljust(w) for c, w in zip(cols, widths))
    body = [" | ".join(cell.ljust(w) if i == 0 else cell.rjust(w) for i, (cell, w) in enumerate(zip(row, widths)))
            for row in cells]
    return "\n".join([head, sep, *body])


def run(data: MovieData | None = None, k: int = K, verbose: bool = True) -> dict[str, pd.DataFrame]:
    """Fit every model on the training split and report both metric families."""
    data = data or load_data()
    movies, ratings = data.movies, data.ratings
    movie_ids = movies["movie_id"].to_numpy()
    train, test = train_test_split_ratings(ratings)

    if verbose:
        print("=" * 78)
        print("MOVIE RECOMMENDER -- OFFLINE EVALUATION")
        print("=" * 78)
        print(f"catalogue      : {len(movies)} movies")
        print(f"ratings        : {len(ratings)} from {ratings.user_id.nunique()} users "
              f"(density {len(ratings) / (ratings.user_id.nunique() * len(movies)):.2%})")
        print(f"split          : {len(train)} train / {len(test)} test "
              f"(per-user {int(TEST_FRACTION * 100)}% hold-out, seed {SEED})")
        print(f"relevance      : test rating >= {RELEVANT_THRESHOLD}, K = {k}")
        print()

    baseline = GlobalMeanBaseline().fit(train)
    item_cf = ItemItemCF().fit(train, movie_ids)
    svd = SVDRecommender().fit(train, movie_ids)
    content = ContentBasedRecommender(movies)
    hybrid = HybridRecommender(
        data=MovieData(movies=movies, ratings=train),
        alpha=0.5,
        content=content,
        item_cf=item_cf,
        svd=svd,
    )

    rating_table = evaluate_rating_predictors(
        {"Baseline (mu+bu+bi)": baseline, "Item-item CF": item_cf, "SVD (k=%d)" % svd.n_components_: svd},
        test,
    )

    pop = weighted_rating(movies, train).reindex(movie_ids).to_numpy()
    pop_norm = _minmax(pop)
    liked_by_user = {
        u: g.loc[g["rating"] >= RELEVANT_THRESHOLD]
        for u, g in train.groupby("user_id")
    }

    def content_scorer(user_id: int) -> np.ndarray:
        liked = liked_by_user.get(user_id)
        if liked is None or liked.empty:
            return pop_norm
        return content.score_for_profile(liked["movie_id"], liked["rating"])

    scorers = {
        "Popularity (IMDb WR)": lambda u: pop_norm,
        "Content-based (TF-IDF)": content_scorer,
        "Item-item CF": lambda u: item_cf.score_all(u),
        "SVD": lambda u: svd.score_all(u),
        "Hybrid (alpha=0.5)": lambda u: hybrid.score_all(u, alpha=0.5),
        "Hybrid (alpha=0.25)": lambda u: hybrid.score_all(u, alpha=0.25),
    }
    ranking_table = evaluate_rankers(scorers, train, test, movie_ids, k=k)

    if verbose:
        print("RATING PREDICTION (lower is better)")
        print("-" * 78)
        print(_table(rating_table))
        print()
        print(f"TOP-{k} RANKING (higher is better)")
        print("-" * 78)
        print(_table(ranking_table))
        print()
        print("Notes: coverage = share of the catalogue that appears in at least one user's")
        print("top-K list; ratings are synthetic (see data/generate_ratings.py).")

    return {"ratings": rating_table, "ranking": ranking_table, "train": train, "test": test}


def main() -> None:  # pragma: no cover
    run()


if __name__ == "__main__":  # pragma: no cover
    main()
