"""Tests for the movie recommendation system."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.collaborative import ItemItemCF, SVDRecommender, build_user_item_matrix, mean_centre
from src.content_based import ContentBasedRecommender, TitleNotFoundError, build_soup
from src.data_loader import (
    DataValidationError,
    clear_cache,
    load_data,
    load_movies,
    load_ratings,
    split_field,
    validate_movies,
    validate_ratings,
)
from src.evaluate import (
    average_precision_at_k,
    mae,
    precision_at_k,
    recall_at_k,
    rmse,
    train_test_split_ratings,
)
from src.hybrid import HybridRecommender, weighted_rating


# --------------------------------------------------------------- fixtures
@pytest.fixture(scope="module")
def data():
    return load_data()


@pytest.fixture(scope="module")
def content(data):
    return ContentBasedRecommender(data.movies)


@pytest.fixture(scope="module")
def item_cf(data):
    return ItemItemCF().fit(data.ratings, data.movies["movie_id"])


@pytest.fixture(scope="module")
def svd(data):
    return SVDRecommender().fit(data.ratings, data.movies["movie_id"])


@pytest.fixture(scope="module")
def hybrid(data, content, item_cf, svd):
    return HybridRecommender(data=data, content=content, item_cf=item_cf, svd=svd)


# ------------------------------------------------------------ data loading
class TestDataLoading:
    def test_movies_load_with_expected_columns(self, data):
        expected = {"movie_id", "title", "year", "genres", "director", "cast",
                    "keywords", "overview", "runtime", "language", "vote_average", "vote_count"}
        assert expected <= set(data.movies.columns)
        assert len(data.movies) >= 250

    def test_ratings_load_and_reference_known_movies(self, data):
        assert len(data.ratings) >= 15_000
        assert data.n_users >= 500
        assert set(data.ratings["movie_id"]) <= set(data.movies["movie_id"])

    def test_no_missing_values_and_sane_ranges(self, data):
        assert not data.movies[["movie_id", "title", "year"]].isna().any().any()
        assert data.movies["vote_average"].between(0, 10).all()
        assert data.ratings["rating"].between(0.5, 5.0).all()
        assert data.movies["movie_id"].is_unique

    def test_caching_returns_equal_but_independent_frames(self):
        first = load_movies()
        second = load_movies()
        pd.testing.assert_frame_equal(first, second)
        first.loc[0, "title"] = "MUTATED"
        assert load_movies().loc[0, "title"] != "MUTATED"

    def test_clear_cache_is_safe(self, data):
        clear_cache()
        assert len(load_movies()) == len(data.movies)

    def test_split_field(self):
        assert split_field("Action|Sci-Fi") == ["Action", "Sci-Fi"]
        assert split_field(None) == []
        assert split_field(float("nan")) == []

    def test_validation_rejects_bad_data(self, data):
        broken = data.movies.drop(columns=["genres"])
        with pytest.raises(DataValidationError):
            validate_movies(broken)

        dupes = pd.concat([data.movies.head(2), data.movies.head(1)])
        with pytest.raises(DataValidationError):
            validate_movies(dupes)

        bad_ratings = data.ratings.head(10).copy()
        bad_ratings.loc[bad_ratings.index[0], "rating"] = 9.9
        with pytest.raises(DataValidationError):
            validate_ratings(bad_ratings)

        unknown = data.ratings.head(5).copy()
        unknown.loc[unknown.index[0], "movie_id"] = 10 ** 9
        with pytest.raises(DataValidationError):
            validate_ratings(unknown, data.movies)

    def test_lookup_helpers(self, data):
        movie_id = data.id_of("The Matrix")
        assert data.title_of(movie_id) == "The Matrix"
        with pytest.raises(KeyError):
            data.title_of(-1)


# ----------------------------------------------------------- content based
class TestContentBased:
    def test_soup_contains_all_fields(self, data):
        row = data.movies.loc[data.movies["title"] == "The Matrix"].iloc[0]
        soup = build_soup(row)
        assert "scifi" in soup and "lanawachowski" in soup and "keanureeves" in soup
        assert "simulation" in soup

    def test_matrix_shapes(self, content, data):
        n = len(data.movies)
        assert content.tfidf.shape[0] == n
        assert content.similarity.shape == (n, n)

    def test_similarity_is_symmetric_with_unit_diagonal(self, content):
        sim = content.similarity
        assert np.allclose(sim, sim.T, atol=1e-5)
        assert np.allclose(np.diag(sim), 1.0, atol=1e-5)
        assert sim.min() >= -1e-6 and sim.max() <= 1.0 + 1e-6

    def test_recommendation_excludes_the_query_movie(self, content, data):
        for title in ["The Matrix", "Inception", "Toy Story", "Alien"]:
            recs = content.recommend(title, n=10)
            assert title not in set(recs["title"])
            assert data.id_of(title) not in set(recs["movie_id"])

    def test_recommendation_shape_and_ordering(self, content):
        recs = content.recommend("The Godfather", n=7)
        assert len(recs) == 7
        assert list(recs["rank"]) == list(range(1, 8))
        assert recs["score"].is_monotonic_decreasing
        assert recs["movie_id"].is_unique

    def test_related_sequels_rank_highly(self, content):
        titles = set(content.recommend("The Godfather", n=5)["title"])
        assert "The Godfather Part II" in titles
        titles = set(content.recommend("Toy Story", n=5)["title"])
        assert "Toy Story 3" in titles

    def test_fuzzy_title_matching(self, content):
        assert content.title_of_index(content.resolve_title("the matrix")) == "The Matrix"
        assert content.title_of_index(content.resolve_title("  The   Matrix ".strip())) == "The Matrix"
        assert content.title_of_index(content.resolve_title("Incepton")) == "Inception"
        assert content.title_of_index(content.resolve_title("pulp fictoin")) == "Pulp Fiction"
        assert content.title_of_index(content.resolve_title("godfather")) == "The Godfather"

    def test_heavy_typo_still_resolves(self, content):
        assert content.title_of_index(content.resolve_title("The Shawshenk Redemtion")) == "The Shawshank Redemption"

    def test_unknown_title_raises_with_suggestions(self, content):
        with pytest.raises(TitleNotFoundError) as excinfo:
            content.recommend("Zzyzx Quantum Banana")
        assert "No movie matching" in str(excinfo.value)

        with pytest.raises(TitleNotFoundError) as excinfo:
            content.recommend("Xyzzy Plugh Godfather Frobnicate Quux")
        assert "Did you mean" in str(excinfo.value)
        assert excinfo.value.suggestions
        assert any("Godfather" in s for s in excinfo.value.suggestions)

    def test_empty_title_raises(self, content):
        with pytest.raises(TitleNotFoundError):
            content.resolve_title("   ")

    def test_explain_lists_shared_metadata(self, content, data):
        a, b = data.id_of("The Godfather"), data.id_of("The Godfather Part II")
        info = content.explain(a, b)
        assert "Crime" in info["genres"] and "Drama" in info["genres"]
        assert info["director"] == "Francis Ford Coppola"
        assert "Al Pacino" in info["cast"]
        assert info["similarity"] > 0.2
        assert "Francis Ford Coppola" in content.explain_text(a, b)

    def test_profile_scoring_excludes_seed_movies(self, content, data):
        seeds = [data.id_of("Alien"), data.id_of("Aliens")]
        scores = content.score_for_profile(seeds, [5.0, 4.5])
        for seed in seeds:
            assert scores[content.index_of_id(seed)] == -np.inf
        assert np.isfinite(scores).sum() == len(data.movies) - 2


# ----------------------------------------------------------- collaborative
class TestCollaborative:
    def test_user_item_matrix_shape_and_values(self, data):
        ui = build_user_item_matrix(data.ratings, data.movies["movie_id"])
        assert ui.shape == (data.n_users, len(data.movies))
        assert ui.matrix.nnz == len(data.ratings)
        assert ui.matrix.data.min() >= 0.5 and ui.matrix.data.max() <= 5.0

    def test_mean_centring_only_touches_observed_entries(self, data):
        ui = build_user_item_matrix(data.ratings.head(500), data.movies["movie_id"])
        means = np.full(ui.shape[1], 3.0, dtype=np.float32)
        centred = mean_centre(ui.matrix, means, axis=0)
        assert centred.nnz <= ui.matrix.nnz
        assert np.allclose(centred.toarray()[ui.matrix.toarray() == 0], 0.0)

    def test_item_similarity_is_symmetric_with_zero_diagonal(self, item_cf):
        sim = item_cf.similarity
        assert sim.shape[0] == sim.shape[1]
        assert np.allclose(sim, sim.T, atol=1e-5)
        assert np.allclose(np.diag(sim), 0.0)
        assert sim.min() >= -1.0 - 1e-6 and sim.max() <= 1.0 + 1e-6

    def test_predictions_are_in_range(self, item_cf, svd, data):
        sample = data.ratings.sample(200, random_state=0)
        for model in (item_cf, svd):
            preds = model.predict_many(int(sample.iloc[0]["user_id"]), sample["movie_id"].head(20))
            assert np.all((preds >= 0.5) & (preds <= 5.0))
            for _, row in sample.head(50).iterrows():
                p = model.predict(int(row["user_id"]), int(row["movie_id"]))
                assert 0.5 <= p <= 5.0

    def test_svd_factor_shapes(self, svd, data):
        assert svd.user_factors.shape == (data.n_users, svd.n_components_)
        assert svd.item_factors.shape == (len(data.movies), svd.n_components_)
        assert 0.0 < svd.explained_variance_ratio_ <= 1.0

    def test_recommendations_exclude_already_rated(self, item_cf, svd, data):
        user = int(data.ratings["user_id"].iloc[0])
        seen = set(data.ratings.loc[data.ratings["user_id"] == user, "movie_id"])
        for model in (item_cf, svd):
            recs = model.recommend(user, n=15)
            assert len(recs) == 15
            assert not (set(recs["movie_id"]) & seen)
            assert recs["score"].is_monotonic_decreasing

    def test_cold_start_user_falls_back_to_item_statistics(self, item_cf, svd, data):
        unknown_user = int(data.ratings["user_id"].max()) + 999
        movie_id = int(data.movies["movie_id"].iloc[0])
        assert 0.5 <= item_cf.predict(unknown_user, movie_id) <= 5.0
        assert 0.5 <= svd.predict(unknown_user, movie_id) <= 5.0
        recs = svd.recommend(unknown_user, n=5)
        assert len(recs) == 5

    def test_cold_start_movie_falls_back(self, item_cf, svd, data):
        user = int(data.ratings["user_id"].iloc[0])
        unknown_movie = int(data.movies["movie_id"].max()) + 999
        assert 0.5 <= item_cf.predict(user, unknown_movie) <= 5.0
        assert 0.5 <= svd.predict(user, unknown_movie) <= 5.0

    def test_models_beat_a_constant_predictor(self, data):
        train, test = train_test_split_ratings(data.ratings, seed=7)
        cf = ItemItemCF().fit(train, data.movies["movie_id"])
        factorised = SVDRecommender().fit(train, data.movies["movie_id"])
        truth = test["rating"].to_numpy(dtype=float)
        constant = np.full_like(truth, float(train["rating"].mean()))
        cf_pred = np.array([cf.predict(int(u), int(m)) for u, m in zip(test["user_id"], test["movie_id"])])
        svd_pred = np.array([factorised.predict(int(u), int(m)) for u, m in zip(test["user_id"], test["movie_id"])])
        assert rmse(truth, cf_pred) < rmse(truth, constant)
        assert rmse(truth, svd_pred) < rmse(truth, constant)


# ------------------------------------------------------------------ hybrid
class TestHybrid:
    def test_weighted_rating_formula(self, data):
        wr = weighted_rating(data.movies, data.ratings)
        assert len(wr) == len(data.movies)
        assert wr.between(0.5, 5.0).all()
        # a movie with many high ratings must outrank one with a single high rating
        counts = data.ratings.groupby("movie_id")["rating"].agg(["mean", "count"])
        busy = counts.loc[counts["count"] >= counts["count"].quantile(0.9)].sort_values("mean").index[-1]
        rare = counts.loc[counts["count"] <= counts["count"].quantile(0.1)].sort_values("mean").index[-1]
        assert wr[busy] > wr[rare] or counts.loc[rare, "mean"] > counts.loc[busy, "mean"]

    def test_alpha_extremes_match_the_pure_models(self, hybrid, data):
        pure_content = hybrid.recommend(title="The Matrix", n=8, alpha=1.0)
        pure_cf = hybrid.recommend(title="The Matrix", n=8, alpha=0.0)
        assert set(pure_content["title"]) != set(pure_cf["title"])
        assert (pure_content["content_score"] >= 0).all()

    def test_alpha_changes_the_ranking(self, hybrid):
        low = hybrid.recommend(user_id=42, n=10, alpha=0.0)["movie_id"].tolist()
        high = hybrid.recommend(user_id=42, n=10, alpha=1.0)["movie_id"].tolist()
        assert low != high

    def test_query_movie_never_recommended(self, hybrid, data):
        for title in ["The Matrix", "Parasite", "Jaws"]:
            recs = hybrid.recommend(title=title, n=12)
            assert data.id_of(title) not in set(recs["movie_id"])

    def test_known_user_recommendations_exclude_seen(self, hybrid, data):
        user = 42
        seen = set(data.ratings.loc[data.ratings["user_id"] == user, "movie_id"])
        recs = hybrid.recommend(user_id=user, n=20)
        assert not (set(recs["movie_id"]) & seen)

    def test_cold_start_user_uses_popularity_fallback(self, hybrid, data):
        unknown = int(data.ratings["user_id"].max()) + 1234
        assert hybrid.is_cold_user(unknown)
        assert hybrid.is_cold_user(None)
        recs = hybrid.recommend(user_id=unknown, n=10)
        assert len(recs) == 10
        assert "popularity" in recs.attrs["method"]
        popular = hybrid.popularity_scores()
        best = data.movies["movie_id"].to_numpy()[np.argsort(-popular)[:10]]
        assert set(recs["movie_id"]) == set(best)

    def test_cold_start_user_with_seed_title_still_personalises(self, hybrid):
        recs = hybrid.recommend(user_id=10 ** 7, title="Alien", n=5)
        assert len(recs) == 5
        assert "Aliens" in set(recs["title"])

    def test_explanations_are_non_empty(self, hybrid, data):
        recs = hybrid.recommend(user_id=42, n=3)
        for movie_id in recs["movie_id"]:
            assert hybrid.explain(int(movie_id), user_id=42)
        recs = hybrid.recommend(title="The Matrix", n=3)
        for movie_id in recs["movie_id"]:
            assert "Similar to The Matrix" in hybrid.explain(int(movie_id), title="The Matrix")
        assert "Popular pick" in hybrid.explain(int(data.movies["movie_id"].iloc[0]))

    def test_predict_delegates_to_collaborative_model(self, hybrid):
        assert 0.5 <= hybrid.predict(42, 14) <= 5.0


# -------------------------------------------------------------- evaluation
class TestEvaluation:
    def test_split_is_disjoint_and_covers_everything(self, data):
        train, test = train_test_split_ratings(data.ratings, test_fraction=0.2, seed=1)
        assert len(train) + len(test) == len(data.ratings)
        pairs_train = set(map(tuple, train[["user_id", "movie_id"]].to_numpy()))
        pairs_test = set(map(tuple, test[["user_id", "movie_id"]].to_numpy()))
        assert not (pairs_train & pairs_test)
        assert train.groupby("user_id").size().min() >= 5

    def test_split_is_deterministic(self, data):
        a, _ = train_test_split_ratings(data.ratings, seed=3)
        b, _ = train_test_split_ratings(data.ratings, seed=3)
        pd.testing.assert_frame_equal(a, b)

    def test_error_metrics(self):
        assert rmse([1, 2, 3], [1, 2, 3]) == 0.0
        assert mae([1, 2, 3], [2, 3, 4]) == pytest.approx(1.0)
        assert rmse([0, 0], [1, 1]) == pytest.approx(1.0)

    def test_ranking_metrics(self):
        recommended = [1, 2, 3, 4, 5]
        relevant = {2, 5, 9}
        assert precision_at_k(recommended, relevant, 5) == pytest.approx(0.4)
        assert recall_at_k(recommended, relevant, 5) == pytest.approx(2 / 3)
        # hits at ranks 2 and 5 -> (1/2 + 2/5) / 3
        assert average_precision_at_k(recommended, relevant, 5) == pytest.approx((0.5 + 0.4) / 3)
        assert precision_at_k(recommended, set(), 5) == 0.0
        assert average_precision_at_k([], {1}, 5) == 0.0
        assert average_precision_at_k([1, 2], {1, 2}, 2) == pytest.approx(1.0)
