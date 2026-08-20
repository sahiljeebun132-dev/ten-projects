"""Content based recommendations: TF-IDF over a metadata "soup" + cosine similarity."""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from .data_loader import load_movies, split_field

# How often each field is repeated inside the soup (a cheap but effective way of
# weighting fields inside a bag-of-words model).
FIELD_WEIGHTS = {"genres": 5, "keywords": 3, "director": 4, "cast": 3, "overview": 1}
TOP_CAST = 4


class TitleNotFoundError(KeyError):
    """Raised when a queried title cannot be matched, carrying "did you mean" hints."""

    def __init__(self, title: str, suggestions: list[str]):
        self.title = title
        self.suggestions = suggestions
        hint = f" Did you mean: {', '.join(suggestions)}?" if suggestions else ""
        super().__init__(f"No movie matching {title!r}.{hint}")

    def __str__(self) -> str:  # KeyError repr adds quotes otherwise
        return self.args[0]


def _tokenise(value: str) -> str:
    """Collapse a multi-word name into a single token ("Christopher Nolan" -> christophernolan)."""
    return re.sub(r"[^a-z0-9]", "", value.lower())


def build_soup(row: pd.Series) -> str:
    """Combine genres + keywords + director + top cast + overview into one string."""
    parts: list[str] = []
    for genre in split_field(row.get("genres")):
        parts += [_tokenise(genre)] * FIELD_WEIGHTS["genres"]
    for keyword in split_field(row.get("keywords")):
        parts += [_tokenise(keyword)] * FIELD_WEIGHTS["keywords"]
    director = str(row.get("director") or "").strip()
    if director:
        parts += [_tokenise(director)] * FIELD_WEIGHTS["director"]
    for actor in split_field(row.get("cast"))[:TOP_CAST]:
        parts += [_tokenise(actor)] * FIELD_WEIGHTS["cast"]
    overview = str(row.get("overview") or "")
    parts += [overview.lower()] * FIELD_WEIGHTS["overview"]
    return " ".join(p for p in parts if p)


@dataclass
class ContentBasedRecommender:
    """TF-IDF + cosine similarity over movie metadata."""

    movies: pd.DataFrame = field(default_factory=load_movies)
    min_df: int = 1
    fitted: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        self.movies = self.movies.reset_index(drop=True)
        self._index_by_id = {int(m): i for i, m in enumerate(self.movies["movie_id"])}
        self._index_by_title = {str(t).lower(): i for i, t in enumerate(self.movies["title"])}
        self._titles = self.movies["title"].astype(str).tolist()
        self.fit()

    # ------------------------------------------------------------------ fit
    def fit(self) -> "ContentBasedRecommender":
        self.soup = self.movies.apply(build_soup, axis=1)
        self.vectorizer = TfidfVectorizer(
            stop_words="english",
            min_df=self.min_df,
            sublinear_tf=True,
            token_pattern=r"(?u)\b\w\w+\b",
        )
        self.tfidf = self.vectorizer.fit_transform(self.soup)
        # rows are L2-normalised by TfidfVectorizer, so the linear kernel *is* cosine
        self.similarity = cosine_similarity(self.tfidf, dense_output=True).astype(np.float32)
        np.fill_diagonal(self.similarity, 1.0)
        self.fitted = True
        return self

    # -------------------------------------------------------------- lookups
    def resolve_title(self, title: str, cutoff: float = 0.6, n_suggestions: int = 5) -> int:
        """Return the row index for ``title`` using exact, substring then fuzzy matching."""
        query = str(title).strip()
        if not query:
            raise TitleNotFoundError(title, [])
        lowered = query.lower()
        if lowered in self._index_by_title:
            return self._index_by_title[lowered]

        # substring match (unique wins, otherwise the shortest title)
        contains = [i for i, t in enumerate(self._titles) if lowered in t.lower()]
        if contains:
            return min(contains, key=lambda i: len(self._titles[i]))

        close = difflib.get_close_matches(lowered, list(self._index_by_title), n=n_suggestions, cutoff=cutoff)
        if close:
            return self._index_by_title[close[0]]

        raise TitleNotFoundError(title, self.suggest(query, n_suggestions))

    def suggest(self, title: str, n: int = 5) -> list[str]:
        """"Did you mean" candidates for an unmatched title."""
        lowered = str(title).strip().lower()
        matches = difflib.get_close_matches(lowered, list(self._index_by_title), n=n, cutoff=0.4)
        out = [self._titles[self._index_by_title[m]] for m in matches]
        if not out:  # fall back on token overlap
            tokens = {t for t in re.split(r"\W+", lowered) if len(t) > 2}
            scored = []
            for i, t in enumerate(self._titles):
                other = {w for w in re.split(r"\W+", t.lower()) if len(w) > 2}
                overlap = len(tokens & other)
                if overlap:
                    scored.append((overlap, -len(t), i))
            scored.sort(reverse=True)
            out = [self._titles[i] for _, _, i in scored[:n]]
        return out

    def index_of_id(self, movie_id: int) -> int:
        try:
            return self._index_by_id[int(movie_id)]
        except KeyError as exc:
            raise KeyError(f"unknown movie_id {movie_id}") from exc

    def title_of_index(self, idx: int) -> str:
        return self._titles[idx]

    # ------------------------------------------------------------ scoring
    def similarity_vector(self, movie_id: int) -> np.ndarray:
        """Similarity of every movie to ``movie_id`` (self-similarity zeroed out)."""
        idx = self.index_of_id(movie_id)
        vec = self.similarity[idx].copy()
        vec[idx] = 0.0
        return vec

    def score_for_profile(self, movie_ids, weights=None) -> np.ndarray:
        """Aggregate similarity to a set of seed movies (a crude user profile)."""
        ids = [int(m) for m in movie_ids if int(m) in self._index_by_id]
        if not ids:
            return np.zeros(len(self.movies), dtype=np.float32)
        idxs = [self._index_by_id[m] for m in ids]
        if weights is None:
            w = np.ones(len(idxs), dtype=np.float32)
        else:
            w = np.asarray(list(weights), dtype=np.float32)[: len(idxs)]
        scores = (self.similarity[idxs] * w[:, None]).sum(axis=0) / max(w.sum(), 1e-9)
        scores[idxs] = -np.inf  # never recommend something already seen
        return scores

    # ----------------------------------------------------------- recommend
    def recommend(self, title: str, n: int = 10, min_score: float = 0.0) -> pd.DataFrame:
        """Top-``n`` movies most similar to ``title`` (the query itself is excluded)."""
        idx = self.resolve_title(title)
        scores = self.similarity[idx].copy()
        scores[idx] = -np.inf
        order = np.argsort(-scores)[: max(n * 3, n)]
        order = [i for i in order if scores[i] > min_score][:n]
        out = self.movies.iloc[order][
            ["movie_id", "title", "year", "genres", "director", "vote_average"]
        ].copy()
        out.insert(0, "rank", range(1, len(out) + 1))
        out["score"] = [float(scores[i]) for i in order]
        out["matched_title"] = self._titles[idx]
        return out.reset_index(drop=True)

    def recommend_by_id(self, movie_id: int, n: int = 10) -> pd.DataFrame:
        return self.recommend(self.movies.at[self.index_of_id(movie_id), "title"], n=n)

    # ------------------------------------------------------------- explain
    def explain(self, movie_id_a: int, movie_id_b: int) -> dict[str, object]:
        """Shared metadata between two movies -- the "why this?" payload."""
        a = self.movies.iloc[self.index_of_id(movie_id_a)]
        b = self.movies.iloc[self.index_of_id(movie_id_b)]

        def shared(field_name: str) -> list[str]:
            first = split_field(a.get(field_name))
            second = set(split_field(b.get(field_name)))
            return [x for x in first if x in second]

        same_director = str(a["director"]) == str(b["director"]) and str(a["director"]).strip() != ""
        return {
            "genres": shared("genres"),
            "cast": shared("cast"),
            "keywords": shared("keywords"),
            "director": str(a["director"]) if same_director else None,
            "same_decade": abs(int(a["year"]) - int(b["year"])) <= 10,
            "similarity": float(self.similarity[self.index_of_id(movie_id_a), self.index_of_id(movie_id_b)]),
        }

    def explain_text(self, movie_id_a: int, movie_id_b: int) -> str:
        info = self.explain(movie_id_a, movie_id_b)
        bits: list[str] = []
        if info["genres"]:
            bits.append("shares the genres " + ", ".join(info["genres"]))
        if info["director"]:
            bits.append(f"also directed by {info['director']}")
        if info["cast"]:
            bits.append("features " + ", ".join(info["cast"][:3]))
        if info["keywords"]:
            bits.append("both involve " + ", ".join(info["keywords"][:3]))
        if not bits:
            bits.append("similar overall description")
        return "; ".join(bits) + f" (cosine {info['similarity']:.2f})"


if __name__ == "__main__":  # pragma: no cover
    rec = ContentBasedRecommender()
    print(rec.recommend("The Matrix", 5).to_string(index=False))
