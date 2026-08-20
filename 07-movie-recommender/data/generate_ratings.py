"""Generate a synthetic-but-realistic ratings dataset for the movie recommender.

The ratings in ``data/ratings.csv`` are NOT real user data: they are produced by
this script from a fixed random seed (``SEED``).  Every user is given a latent
preference vector over genres, decades and "quality sensitivity"; movies are
described by the matching latent factors derived from ``data/movies.csv``.  A
rating is then

    score = mu + b_user + b_movie + <p_user, q_movie> + noise

which is exactly the structure that matrix factorisation and item-item
collaborative filtering are able to recover -- so the recommenders trained on
this file produce meaningful (not random) results.

Run:  python data/generate_ratings.py
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

SEED = 42
N_USERS = 600
N_RATINGS = 20_000

# Strength of the latent taste signal relative to noise.  These are what make
# collaborative filtering beat a bias-only baseline on this dataset.
GLOBAL_MEAN = 2.90
TASTE_WEIGHT = 1.15     # stars contributed by the user x movie interaction
NOISE_STD = 0.42        # unexplainable per-rating noise
USER_BIAS_STD = 0.38
MOVIE_BIAS_WEIGHT = 0.32

DATA_DIR = Path(__file__).resolve().parent
MOVIES_CSV = DATA_DIR / "movies.csv"
RATINGS_CSV = DATA_DIR / "ratings.csv"

# Rough taste archetypes.  Each user is a noisy blend of one or two of these,
# which creates the block structure that collaborative filtering exploits.
ARCHETYPES = {
    "blockbuster": {"Action": 1.4, "Adventure": 1.3, "Sci-Fi": 1.0, "Fantasy": 0.9, "Family": 0.5, "Drama": -0.3, "History": -0.5},
    "cinephile": {"Drama": 1.2, "History": 0.9, "Mystery": 0.7, "War": 0.6, "Biography": 0.6, "Action": -0.6, "Family": -0.5},
    "genre_horror": {"Horror": 1.7, "Thriller": 1.1, "Mystery": 0.8, "Sci-Fi": 0.4, "Romance": -0.8, "Family": -0.9, "Music": -0.5},
    "romantic": {"Romance": 1.6, "Drama": 0.8, "Comedy": 0.7, "Music": 0.6, "Horror": -1.1, "War": -0.7},
    "family_animation": {"Animation": 1.7, "Family": 1.5, "Adventure": 0.8, "Comedy": 0.7, "Horror": -1.3, "Crime": -0.8},
    "crime_thriller": {"Crime": 1.5, "Thriller": 1.2, "Drama": 0.6, "Mystery": 0.7, "Western": 0.4, "Animation": -0.9, "Family": -0.8},
    "sci_fi_nerd": {"Sci-Fi": 1.7, "Fantasy": 0.9, "Adventure": 0.7, "Action": 0.6, "Romance": -0.6, "Sport": -0.5},
    "comedy_casual": {"Comedy": 1.6, "Romance": 0.6, "Adventure": 0.4, "Family": 0.5, "War": -0.8, "History": -0.7},
}
ARCHETYPE_NAMES = list(ARCHETYPES)


def _genre_matrix(movies: pd.DataFrame) -> tuple[np.ndarray, list[str]]:
    genres = sorted({g for row in movies["genres"] for g in row.split("|")})
    index = {g: i for i, g in enumerate(genres)}
    mat = np.zeros((len(movies), len(genres)), dtype=float)
    for r, row in enumerate(movies["genres"]):
        parts = row.split("|")
        for g in parts:
            mat[r, index[g]] = 1.0 / np.sqrt(len(parts))
    return mat, genres


def generate(n_users: int = N_USERS, n_ratings: int = N_RATINGS, seed: int = SEED) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    movies = pd.read_csv(MOVIES_CSV)
    n_movies = len(movies)

    gmat, genres = _genre_matrix(movies)
    n_genres = len(genres)

    # ---- movie side latent factors -------------------------------------
    quality = (movies["vote_average"].to_numpy() - movies["vote_average"].mean()) / movies["vote_average"].std()
    year = movies["year"].to_numpy()
    modernity = (year - year.mean()) / year.std()
    log_votes = np.log1p(movies["vote_count"].to_numpy())
    fame = (log_votes - log_votes.mean()) / log_votes.std()
    movie_bias = MOVIE_BIAS_WEIGHT * quality + rng.normal(0, 0.16, n_movies)

    # ---- user side latent factors --------------------------------------
    user_pref = np.zeros((n_users, n_genres))
    for u in range(n_users):
        primary = rng.choice(len(ARCHETYPE_NAMES))
        secondary = rng.choice(len(ARCHETYPE_NAMES))
        weight = rng.uniform(0.55, 0.85)
        vec = np.zeros(n_genres)
        for arch, w in ((primary, weight), (secondary, 1.0 - weight)):
            for g, v in ARCHETYPES[ARCHETYPE_NAMES[arch]].items():
                vec[genres.index(g)] += w * v
        user_pref[u] = vec + rng.normal(0, 0.22, n_genres)

    user_bias = rng.normal(0.0, USER_BIAS_STD, n_users)          # generous vs harsh raters
    user_quality_sens = rng.normal(0.45, 0.22, n_users)  # how much acclaim matters
    user_modernity = rng.normal(0.0, 0.42, n_users)      # classics vs new releases
    global_mean = GLOBAL_MEAN

    # affinity[u, i] = how much user u is expected to like movie i
    affinity = (
        user_pref @ gmat.T
        + np.outer(user_quality_sens, quality)
        + np.outer(user_modernity, modernity)
    )
    # standardise so the taste term contributes a predictable number of stars
    affinity = (affinity - affinity.mean()) / affinity.std()

    # ---- who rates what -------------------------------------------------
    # Users mostly watch popular films and films close to their taste, which is
    # what makes real rating matrices sparse *and* non-uniformly missing.
    exposure = 0.95 * fame + 0.55 * np.clip(affinity, -3, 3) + rng.normal(0, 0.9, (n_users, n_movies))
    per_user = rng.integers(12, 70, size=n_users)
    per_user = np.round(per_user * (n_ratings / per_user.sum())).astype(int)
    per_user = np.clip(per_user, 8, n_movies)

    rows: list[tuple[int, int, float, int]] = []
    base_ts = 1_262_304_000  # 2010-01-01
    for u in range(n_users):
        k = int(per_user[u])
        # Gumbel trick = sampling without replacement proportional to softmax(exposure)
        keys = exposure[u] + rng.gumbel(0, 1.0, n_movies)
        picks = np.argpartition(-keys, k - 1)[:k]
        raw = (
            global_mean
            + user_bias[u]
            + movie_bias[picks]
            + TASTE_WEIGHT * affinity[u, picks]
            + rng.normal(0, NOISE_STD, k)
        )
        stars = np.clip(np.round(raw * 2.0) / 2.0, 0.5, 5.0)
        ts = base_ts + rng.integers(0, 400_000_000, size=k)
        for i, s, t in zip(picks, stars, ts):
            rows.append((u + 1, int(movies.at[int(i), "movie_id"]), float(s), int(t)))

    df = pd.DataFrame(rows, columns=["user_id", "movie_id", "rating", "timestamp"])
    df = df.sort_values(["user_id", "timestamp"], kind="stable").reset_index(drop=True)
    return df


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate synthetic ratings.csv")
    parser.add_argument("--users", type=int, default=N_USERS)
    parser.add_argument("--ratings", type=int, default=N_RATINGS)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--out", type=Path, default=RATINGS_CSV)
    args = parser.parse_args()

    df = generate(args.users, args.ratings, args.seed)
    df.to_csv(args.out, index=False)

    print(f"wrote {args.out}")
    print(f"  ratings : {len(df):,}")
    print(f"  users   : {df.user_id.nunique():,}")
    print(f"  movies  : {df.movie_id.nunique():,}")
    print(f"  density : {len(df) / (df.user_id.nunique() * df.movie_id.nunique()):.3%}")
    print(f"  mean    : {df.rating.mean():.3f}  std {df.rating.std():.3f}")
    print("  histogram:")
    for star, cnt in df.rating.value_counts().sort_index().items():
        print(f"    {star:>3}  {'#' * int(60 * cnt / len(df)):<60} {cnt:>6}")


if __name__ == "__main__":
    main()
