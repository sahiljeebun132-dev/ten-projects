"""Loading, validation and caching of the movie / ratings datasets."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"
MOVIES_CSV = DATA_DIR / "movies.csv"
RATINGS_CSV = DATA_DIR / "ratings.csv"

MOVIE_COLUMNS = [
    "movie_id", "title", "year", "genres", "director", "cast",
    "keywords", "overview", "runtime", "language", "vote_average", "vote_count",
]
RATING_COLUMNS = ["user_id", "movie_id", "rating"]

LIST_FIELDS = ("genres", "cast", "keywords")

# path -> (mtime, dataframe)
_CACHE: dict[str, tuple[float, pd.DataFrame]] = {}


class DataValidationError(ValueError):
    """Raised when a dataset is missing columns or contains impossible values."""


@dataclass(frozen=True)
class MovieData:
    """Bundle of the two datasets plus a few handy lookups."""

    movies: pd.DataFrame
    ratings: pd.DataFrame

    @property
    def n_movies(self) -> int:
        return len(self.movies)

    @property
    def n_users(self) -> int:
        return int(self.ratings["user_id"].nunique())

    @property
    def n_ratings(self) -> int:
        return len(self.ratings)

    def title_of(self, movie_id: int) -> str:
        row = self.movies.loc[self.movies["movie_id"] == movie_id]
        if row.empty:
            raise KeyError(f"unknown movie_id {movie_id}")
        return str(row.iloc[0]["title"])

    def id_of(self, title: str) -> int:
        row = self.movies.loc[self.movies["title"].str.lower() == title.strip().lower()]
        if row.empty:
            raise KeyError(f"unknown title {title!r}")
        return int(row.iloc[0]["movie_id"])


def split_field(value: object) -> list[str]:
    """Split a pipe separated cell into a clean list of strings."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return []
    return [part.strip() for part in str(value).split("|") if part.strip()]


def _require_columns(df: pd.DataFrame, columns: Iterable[str], name: str) -> None:
    missing = [c for c in columns if c not in df.columns]
    if missing:
        raise DataValidationError(f"{name} is missing column(s): {', '.join(missing)}")


def _read_csv_cached(path: Path) -> pd.DataFrame:
    key = str(path)
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError as exc:  # pragma: no cover - defensive
        raise DataValidationError(f"dataset not found: {path}") from exc
    cached = _CACHE.get(key)
    if cached is not None and cached[0] == mtime:
        return cached[1].copy()
    df = pd.read_csv(path)
    _CACHE[key] = (mtime, df)
    return df.copy()


def clear_cache() -> None:
    """Drop the in-process dataset cache (used by the tests)."""
    _CACHE.clear()


def validate_movies(movies: pd.DataFrame) -> pd.DataFrame:
    _require_columns(movies, MOVIE_COLUMNS, "movies.csv")
    if movies.empty:
        raise DataValidationError("movies.csv is empty")
    if movies["movie_id"].duplicated().any():
        dupes = movies.loc[movies["movie_id"].duplicated(), "movie_id"].tolist()
        raise DataValidationError(f"duplicate movie_id values: {dupes[:5]}")
    if movies["title"].isna().any() or (movies["title"].astype(str).str.strip() == "").any():
        raise DataValidationError("movies.csv contains blank titles")
    for col in ("year", "runtime", "vote_count"):
        if not pd.api.types.is_numeric_dtype(movies[col]):
            raise DataValidationError(f"movies.csv column {col!r} must be numeric")
    if not movies["vote_average"].between(0, 10).all():
        raise DataValidationError("vote_average must lie in [0, 10]")
    if not movies["year"].between(1880, 2100).all():
        raise DataValidationError("year must lie in [1880, 2100]")
    for col in LIST_FIELDS + ("director", "overview", "language"):
        movies[col] = movies[col].fillna("").astype(str)
    return movies


def validate_ratings(ratings: pd.DataFrame, movies: pd.DataFrame | None = None) -> pd.DataFrame:
    _require_columns(ratings, RATING_COLUMNS, "ratings.csv")
    if ratings.empty:
        raise DataValidationError("ratings.csv is empty")
    if not ratings["rating"].between(0.5, 5.0).all():
        raise DataValidationError("ratings must lie in [0.5, 5.0]")
    if ratings.duplicated(subset=["user_id", "movie_id"]).any():
        n = int(ratings.duplicated(subset=["user_id", "movie_id"]).sum())
        raise DataValidationError(f"ratings.csv contains {n} duplicate (user_id, movie_id) pairs")
    if movies is not None:
        unknown = set(ratings["movie_id"]) - set(movies["movie_id"])
        if unknown:
            raise DataValidationError(
                f"ratings.csv references {len(unknown)} movie_id(s) absent from movies.csv"
            )
    return ratings


def load_movies(path: Path | str = MOVIES_CSV) -> pd.DataFrame:
    """Load and validate the movie catalogue (cached on file mtime)."""
    movies = _read_csv_cached(Path(path))
    movies = validate_movies(movies)
    return movies.reset_index(drop=True)


def load_ratings(path: Path | str = RATINGS_CSV, movies: pd.DataFrame | None = None) -> pd.DataFrame:
    """Load and validate the ratings table (cached on file mtime)."""
    ratings = _read_csv_cached(Path(path))
    ratings = validate_ratings(ratings, movies)
    return ratings.reset_index(drop=True)


def load_data(
    movies_path: Path | str = MOVIES_CSV,
    ratings_path: Path | str = RATINGS_CSV,
) -> MovieData:
    """Load both datasets, cross-validated against each other."""
    movies = load_movies(movies_path)
    ratings = load_ratings(ratings_path, movies)
    return MovieData(movies=movies, ratings=ratings)


def dataset_summary(data: MovieData) -> str:
    density = data.n_ratings / (data.n_users * data.movies["movie_id"].nunique())
    return (
        f"{data.n_movies} movies | {data.n_users} users | {data.n_ratings} ratings "
        f"| density {density:.2%} | mean rating {data.ratings['rating'].mean():.2f}"
    )


if __name__ == "__main__":  # pragma: no cover
    print(dataset_summary(load_data()))
