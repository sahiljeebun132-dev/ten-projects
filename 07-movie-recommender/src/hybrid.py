"""Hybrid recommender: weighted blend of content similarity and collaborative scores,
with an IMDb weighted-rating popularity fallback for cold-start users and movies."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .collaborative import ItemItemCF, SVDRecommender
from .content_based import ContentBasedRecommender
from .data_loader import MovieData, load_data

COLD_START_MIN_RATINGS = 3
LIKE_THRESHOLD = 4.0


def weighted_rating(
    movies: pd.DataFrame,
    ratings: pd.DataFrame | None = None,
    quantile: float = 0.70,
) -> pd.Series:
    """IMDb weighted rating   WR = v/(v+m) * R + m/(v+m) * C.

    ``R`` = mean rating of the movie, ``v`` = number of votes, ``m`` = minimum
    votes required to be listed (a quantile of the vote counts) and ``C`` = the
    mean rating across the whole catalogue.  Returned indexed by ``movie_id``.
    """
    if ratings is not None and len(ratings):
        agg = ratings.groupby("movie_id")["rating"].agg(["mean", "count"])
        R = agg["mean"].reindex(movies["movie_id"]).fillna(0.0).to_numpy()
        v = agg["count"].reindex(movies["movie_id"]).fillna(0.0).to_numpy()
        C = float(ratings["rating"].mean())
    else:
        R = movies["vote_average"].to_numpy(dtype=float)
        v = movies["vote_count"].to_numpy(dtype=float)
        C = float(np.average(R, weights=np.clip(v, 1, None)))
    m = float(np.quantile(v, quantile)) if v.size else 0.0
    wr = (v / (v + m + 1e-9)) * R + (m / (v + m + 1e-9)) * C
    return pd.Series(wr, index=movies["movie_id"].to_numpy(), name="weighted_rating")


def _minmax(x: np.ndarray) -> np.ndarray:
    """Scale finite values to [0, 1]; non-finite entries become 0."""
    x = np.asarray(x, dtype=float).copy()
    finite = np.isfinite(x)
    if not finite.any():
        return np.zeros_like(x)
    lo, hi = float(x[finite].min()), float(x[finite].max())
    out = np.zeros_like(x)
    out[finite] = 0.5 if hi - lo < 1e-12 else (x[finite] - lo) / (hi - lo)
    return out


@dataclass
class HybridRecommender:
    """alpha * content + (1 - alpha) * collaborative, with popularity fallback.

    ``alpha = 1`` is pure content based, ``alpha = 0`` is pure collaborative.
    """

    data: MovieData = field(default_factory=load_data)
    alpha: float = 0.5
    cf_model: str = "svd"           # "svd" or "item"
    content: ContentBasedRecommender | None = None
    item_cf: ItemItemCF | None = None
    svd: SVDRecommender | None = None

    def __post_init__(self) -> None:
        movies, ratings = self.data.movies, self.data.ratings
        self.movie_ids = movies["movie_id"].to_numpy()
        self.content = self.content or ContentBasedRecommender(movies)
        self.item_cf = self.item_cf or ItemItemCF().fit(ratings, self.movie_ids)
        self.svd = self.svd or SVDRecommender().fit(ratings, self.movie_ids)
        self.popularity = weighted_rating(movies, ratings).reindex(self.movie_ids).to_numpy()
        self._counts = ratings.groupby("user_id").size()
        self._titles = dict(zip(movies["movie_id"], movies["title"]))

    # ------------------------------------------------------------ helpers
    def _cf(self):
        return self.svd if self.cf_model == "svd" else self.item_cf

    def is_cold_user(self, user_id: int | None) -> bool:
        if user_id is None:
            return True
        return int(self._counts.get(int(user_id), 0)) < COLD_START_MIN_RATINGS

    def user_profile(self, user_id: int) -> pd.DataFrame:
        r = self.data.ratings
        return r.loc[r["user_id"] == int(user_id)].sort_values("rating", ascending=False)

    def popularity_scores(self) -> np.ndarray:
        return self.popularity.copy()

    def content_scores(self, title: str | None = None, user_id: int | None = None) -> np.ndarray:
        """Content signal either from a seed title or from the user's liked movies."""
        if title:
            idx = self.content.resolve_title(title)
            scores = self.content.similarity[idx].astype(float).copy()
            scores[idx] = -np.inf
            return scores
        if user_id is not None and not self.is_cold_user(user_id):
            profile = self.user_profile(user_id)
            liked = profile.loc[profile["rating"] >= LIKE_THRESHOLD]
            if liked.empty:
                liked = profile.head(5)
            return self.content.score_for_profile(liked["movie_id"], liked["rating"]).astype(float)
        return np.zeros(len(self.movie_ids), dtype=float)

    def cf_scores(self, user_id: int | None = None, title: str | None = None) -> np.ndarray:
        """Collaborative signal: personalised for a known user, item-item for a seed title."""
        if user_id is not None and not self.is_cold_user(user_id):
            return self._cf().score_all(user_id).astype(float)
        if title:
            idx = self.content.resolve_title(title)
            movie_id = int(self.movie_ids[idx])
            if self.item_cf.ui.has_movie(movie_id):
                j = self.item_cf.ui.movie_index[movie_id]
                sims = self.item_cf.similarity[j].astype(float).copy()
                sims[j] = -np.inf
                return sims
        return np.zeros(len(self.movie_ids), dtype=float)

    # --------------------------------------------------------- recommend
    def recommend(
        self,
        user_id: int | None = None,
        title: str | None = None,
        n: int = 10,
        alpha: float | None = None,
        exclude_seen: bool = True,
    ) -> pd.DataFrame:
        """Blend content + collaborative scores; fall back to popularity when cold."""
        alpha = self.alpha if alpha is None else float(alpha)
        cold_user = self.is_cold_user(user_id)
        cold = (user_id is None or cold_user) and not title

        content = self.content_scores(title=title, user_id=user_id)
        cf = self.cf_scores(user_id=user_id, title=title)
        c_norm, f_norm = _minmax(content), _minmax(cf)

        if cold:
            method = "popularity (cold start)"
            blended = _minmax(self.popularity)
        elif cold_user and title:
            seed = self.content.title_of_index(self.content.resolve_title(title))
            method = f"content+item-cf seeded on '{seed}' (no user history)"
            blended = alpha * c_norm + (1 - alpha) * f_norm
        elif title:
            method = f"hybrid alpha={alpha:.2f} (seed title + user)"
            blended = alpha * c_norm + (1 - alpha) * f_norm
        else:
            method = f"hybrid alpha={alpha:.2f}"
            blended = alpha * c_norm + (1 - alpha) * f_norm

        # small popularity prior keeps obscure long-tail noise out of the top slots
        blended = blended + 0.05 * _minmax(self.popularity)

        mask = np.ones(len(self.movie_ids), dtype=bool)
        if not np.isfinite(content).all():
            mask &= np.isfinite(content)
        if exclude_seen and user_id is not None and not cold_user:
            seen = set(self.user_profile(user_id)["movie_id"].tolist())
            mask &= ~np.isin(self.movie_ids, list(seen))
        if title:
            mask &= self.movie_ids != int(self.movie_ids[self.content.resolve_title(title)])

        scores = np.where(mask, blended, -np.inf)
        order = np.argsort(-scores)[:n]
        order = [i for i in order if np.isfinite(scores[i])]

        movies = self.data.movies.iloc[order]
        out = movies[["movie_id", "title", "year", "genres", "director", "vote_average"]].copy()
        out.insert(0, "rank", range(1, len(out) + 1))
        out["score"] = scores[order]
        out["content_score"] = c_norm[order]
        out["cf_score"] = f_norm[order]
        out["popularity"] = self.popularity[order]
        out.attrs["method"] = method
        return out.reset_index(drop=True)

    def score_all(self, user_id: int, alpha: float | None = None) -> np.ndarray:
        alpha = self.alpha if alpha is None else float(alpha)
        if self.is_cold_user(user_id):
            return _minmax(self.popularity)
        return alpha * _minmax(self.content_scores(user_id=user_id)) + (1 - alpha) * _minmax(self.cf_scores(user_id=user_id))

    def predict(self, user_id: int, movie_id: int) -> float:
        """Rating prediction (delegated to the collaborative model)."""
        return self._cf().predict(user_id, movie_id)

    # ------------------------------------------------------------ explain
    def explain(self, movie_id: int, user_id: int | None = None, title: str | None = None) -> str:
        """Human readable "why this?" for one recommended movie."""
        if title:
            seed_id = int(self.movie_ids[self.content.resolve_title(title)])
            return f"Similar to {self._titles[seed_id]}: " + self.content.explain_text(seed_id, movie_id)
        if user_id is not None and not self.is_cold_user(user_id):
            profile = self.user_profile(user_id)
            liked = profile.loc[profile["rating"] >= LIKE_THRESHOLD].head(20)
            if not liked.empty:
                sims = [
                    (float(self.content.similarity[self.content.index_of_id(mid), self.content.index_of_id(movie_id)]), int(mid))
                    for mid in liked["movie_id"]
                ]
                sims.sort(reverse=True)
                best_sim, best_id = sims[0]
                if best_sim > 0:
                    return (
                        f"You rated {self._titles[best_id]} "
                        f"{float(profile.loc[profile.movie_id == best_id, 'rating'].iloc[0]):.1f}/5 - "
                        + self.content.explain_text(best_id, movie_id)
                    )
            return "Users with similar taste rated this highly."
        idx = int(np.where(self.movie_ids == int(movie_id))[0][0])
        return f"Popular pick (weighted rating {self.popularity[idx]:.2f}) - shown because we know nothing about you yet."


if __name__ == "__main__":  # pragma: no cover
    hyb = HybridRecommender()
    print(hyb.recommend(user_id=42, n=5)[["title", "year", "score"]].to_string(index=False))
