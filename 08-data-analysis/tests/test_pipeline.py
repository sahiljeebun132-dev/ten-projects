"""
Pipeline tests
==============

Three groups:

1. **Unit tests on a hand-built fixture** - the arithmetic of the feature layer
   is checked against numbers worked out by hand, so a silent change in the
   revenue/margin definitions fails the build.
2. **Cleaning contract tests** - idempotency (`clean(clean(x)) == clean(x)`) and
   the post-clean invariants that the rest of the pipeline assumes (no nulls in
   key columns, dates parsed, outliers flagged rather than deleted).
3. **Integration tests on the real generated dataset** - skipped automatically
   if `data/raw` has not been generated yet.

Run with::

    python -m pytest tests/ -v
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

import analysis                                            # noqa: E402
import cleaning                                            # noqa: E402
import config                                              # noqa: E402
import features                                            # noqa: E402


# ===========================================================================
# Fixtures
# ===========================================================================
@pytest.fixture(scope="module")
def tiny_raw():
    """A deliberately messy four-line ledger with known correct answers."""
    orders = pd.DataFrame(
        {
            "order_id": ["O1", "O1", "O2", "O3", "O3"],
            "customer_id": ["C1", "C1", "C1", "C2", "C2"],
            # both date formats on purpose
            "order_date": ["2024-01-10", "10/01/2024", "10/03/2024", "2024-02-01", "2024-02-01"],
            "product_id": ["P1", "P2", "P1", "P2", "P1"],
            "quantity": ["2", "1", "1", "3", "-1"],          # last one is a return
            "unit_price": ["20.00", "$100.00", "20", "100.00", "20.00"],
            "discount": ["0.1", "0", "0", "20.0%", None],    # None -> 0.0
            "shipping_cost": ["5", "0", "3", "4", "0"],
            "payment_method": ["Credit Card", "Credit Card", "PayPal", None, "PayPal"],
            "channel": ["Web", "Web", "Web", "Mobile App", "Mobile App"],
            "region": ["North", "North", "North", None, "South"],
        }
    )
    customers = pd.DataFrame(
        {
            "customer_id": ["C1", "C2"],
            "signup_date": ["2023-12-01", "15/01/2024"],
            "age": ["34", "999"],                            # impossible age
            "gender": ["F", None],
            "city": ["  manchester ", "BRISTOL"],            # messy capitalisation
            "region": ["North", "South"],
            "segment": ["Consumer", "Corporate"],
        }
    )
    products = pd.DataFrame(
        {
            "product_id": ["P1", "P2"],
            "name": ["Widget", "Gadget"],
            "category": [" electronics ", "BEAUTY"],         # messy category labels
            "subcategory": ["Phones", None],
            "cost": ["10.00", "50.00"],
            "list_price": ["20.00", "100.00"],
            "supplier": ["SUP-001", None],
        }
    )
    return orders, customers, products


@pytest.fixture(scope="module")
def tiny_clean(tiny_raw):
    orders, customers, products = tiny_raw
    p = cleaning.clean_products(products)
    c = cleaning.clean_customers(customers)
    o = cleaning.clean_orders(orders, c, p)
    return o, c, p


@pytest.fixture(scope="module")
def lines(tiny_clean):
    """Order-line features for the hand-built fixture."""
    o, c, p = tiny_clean
    return features.build_order_lines(o, c, p)


@pytest.fixture(scope="module")
def real_clean():
    if not os.path.exists(config.RAW_ORDERS):
        pytest.skip("data/raw not generated - run `python data/generate_dataset.py`")
    orders, customers, products, log = cleaning.run_cleaning(write=False, verbose=False)
    return orders, customers, products, log


@pytest.fixture(scope="module")
def real_features(real_clean):
    orders, customers, products, _ = real_clean
    return features.build_all(orders, customers, products, write=False, verbose=False)


# ===========================================================================
# 1. Cleaning primitives
# ===========================================================================
class TestCleaningPrimitives:
    def test_to_number_handles_currency_percent_and_numeric(self):
        s = pd.Series(["$1,299.00", "15.0%", " 12 ", "3.5", None, 7.0], dtype=object)
        out = cleaning.to_number(s)
        assert out.iloc[0] == pytest.approx(1299.00)
        assert out.iloc[1] == pytest.approx(0.15)
        assert out.iloc[2] == pytest.approx(12.0)
        assert out.iloc[3] == pytest.approx(3.5)
        assert pd.isna(out.iloc[4])
        assert out.iloc[5] == pytest.approx(7.0)
        assert out.dtype == "float64"

    def test_to_number_is_idempotent(self):
        s = pd.Series(["$1,299.00", "15.0%", None], dtype=object)
        once = cleaning.to_number(s)
        twice = cleaning.to_number(once)
        pd.testing.assert_series_equal(once, twice)

    def test_parse_dates_handles_both_formats_without_dayfirst_guessing(self):
        s = pd.Series(["2024-03-04", "04/03/2024", "31/12/2023", None])
        out = cleaning.parse_dates(s)
        # 04/03/2024 is D/M/Y -> 4 March, i.e. identical to the ISO value above it
        assert out.iloc[0] == pd.Timestamp("2024-03-04")
        assert out.iloc[1] == pd.Timestamp("2024-03-04")
        assert out.iloc[2] == pd.Timestamp("2023-12-31")
        assert pd.isna(out.iloc[3])

    def test_parse_dates_is_idempotent(self):
        s = pd.Series(["2024-03-04", "04/03/2024"])
        once = cleaning.parse_dates(s)
        pd.testing.assert_series_equal(once, cleaning.parse_dates(once))

    def test_normalise_text_collapses_case_and_whitespace(self):
        s = pd.Series(["  new  york ", "NEW YORK", "New York"])
        out = cleaning.normalise_text(s)
        assert out.nunique() == 1
        assert out.iloc[0] == "New York"

    def test_iqr_flags_marks_only_the_extremes(self):
        s = pd.Series([10, 11, 12, 11, 10, 12, 11, 1000])
        mask, lo, hi = cleaning.iqr_flags(s)
        assert bool(mask.iloc[-1]) is True
        assert mask.sum() == 1
        assert lo < 10 and hi < 1000


# ===========================================================================
# 2. Cleaning on the fixture: correctness + invariants
# ===========================================================================
class TestCleaningFixture:
    def test_types_and_values(self, tiny_clean):
        o, c, p = tiny_clean
        assert pd.api.types.is_datetime64_any_dtype(o["order_date"])
        assert o["quantity"].dtype == "int64"
        assert o["unit_price"].dtype == "float64"
        # "$100.00" -> 100.0 and "20.0%" -> 0.20
        assert o.loc[o["product_id"] == "P2", "unit_price"].max() == pytest.approx(100.0)
        assert o["discount"].max() == pytest.approx(0.20)

    def test_missing_discount_filled_with_zero(self, tiny_clean):
        o, _, _ = tiny_clean
        assert o["discount"].notna().all()
        assert (o["discount"] >= 0).all()

    def test_region_backfilled_from_customers(self, tiny_clean):
        o, _, _ = tiny_clean
        # the O3/P2 line had a null region; C2 lives in South
        assert set(o["region"].unique()) <= {"North", "South"}
        assert "Unknown" not in set(o["region"].unique())

    def test_returns_are_flagged_not_deleted(self, tiny_clean):
        o, _, _ = tiny_clean
        assert o["is_return"].sum() == 1
        assert (o.loc[o["is_return"], "quantity"] < 0).all()
        assert len(o) == 5                       # nothing dropped

    def test_impossible_age_nulled_then_imputed_and_flagged(self, tiny_clean):
        _, c, _ = tiny_clean
        assert c["age"].notna().all()
        assert (c["age"].between(16, 100)).all()
        assert bool(c.loc[c["customer_id"] == "C2", "is_age_imputed"].iloc[0]) is True
        assert bool(c.loc[c["customer_id"] == "C1", "is_age_imputed"].iloc[0]) is False

    def test_category_and_city_normalised(self, tiny_clean):
        _, c, p = tiny_clean
        assert set(p["category"]) == {"Electronics", "Beauty"}
        assert set(c["city"]) == {"Manchester", "Bristol"}

    def test_no_nulls_anywhere_after_cleaning(self, tiny_clean):
        o, c, p = tiny_clean
        assert o.isna().sum().sum() == 0
        assert c.isna().sum().sum() == 0
        assert p.isna().sum().sum() == 0

    def test_cleaning_is_idempotent(self, tiny_clean):
        o, c, p = tiny_clean
        pd.testing.assert_frame_equal(o, cleaning.clean_orders(o, c, p))
        pd.testing.assert_frame_equal(c, cleaning.clean_customers(c))
        pd.testing.assert_frame_equal(p, cleaning.clean_products(p))

    def test_exact_duplicates_are_removed(self, tiny_raw):
        orders, customers, products = tiny_raw
        c = cleaning.clean_customers(customers)
        p = cleaning.clean_products(products)
        doubled = pd.concat([orders, orders], ignore_index=True)
        cleaned = cleaning.clean_orders(doubled, c, p)
        assert len(cleaned) == len(cleaning.clean_orders(orders, c, p))
        assert cleaned.duplicated().sum() == 0

    def test_rows_with_missing_quantity_are_dropped(self, tiny_raw):
        orders, customers, products = tiny_raw
        c = cleaning.clean_customers(customers)
        p = cleaning.clean_products(products)
        broken = orders.copy()
        broken.loc[0, "quantity"] = None
        cleaned = cleaning.clean_orders(broken, c, p)
        assert len(cleaned) == len(orders) - 1


# ===========================================================================
# 3. Feature correctness on the fixture (numbers worked out by hand)
# ===========================================================================
class TestFeatures:
    def test_money_arithmetic(self, lines):
        # O1 / P1: qty 2 @ 20.00 with 10% off, cost 10.00
        row = lines[(lines["order_id"] == "O1") & (lines["product_id"] == "P1")].iloc[0]
        assert row["gross_revenue"] == pytest.approx(40.0)
        assert row["discount_amount"] == pytest.approx(4.0)
        assert row["net_revenue"] == pytest.approx(36.0)
        assert row["cogs"] == pytest.approx(20.0)
        assert row["gross_profit"] == pytest.approx(16.0)
        assert row["margin_pct"] == pytest.approx(16.0 / 36.0)
        assert row["contribution"] == pytest.approx(16.0 - 5.0)

    def test_return_line_carries_negative_revenue(self, lines):
        row = lines[(lines["order_id"] == "O3") & (lines["product_id"] == "P1")].iloc[0]
        assert row["quantity"] == -1
        assert row["net_revenue"] < 0
        assert row["gross_profit"] == pytest.approx(-1 * 20.0 - (-1 * 10.0))

    def test_calendar_features(self, lines):
        row = lines[lines["order_id"] == "O2"].iloc[0]
        assert row["order_date"] == pd.Timestamp("2024-03-10")
        assert row["year"] == 2024 and row["month"] == 3 and row["quarter"] == 1
        assert row["day_name"] == "Sunday" and bool(row["is_weekend"]) is True
        assert row["order_month"] == pd.Timestamp("2024-03-01")

    def test_cohort_index_counts_months_since_first_purchase(self, lines):
        c1 = lines[lines["customer_id"] == "C1"]
        assert (c1["cohort_month"] == pd.Timestamp("2024-01-01")).all()
        assert set(c1["cohort_index"]) == {0, 2}

    def test_tenure_is_days_since_signup(self, lines):
        row = lines[lines["order_id"] == "O2"].iloc[0]
        assert row["tenure_days"] == (pd.Timestamp("2024-03-10") - pd.Timestamp("2023-12-01")).days

    def test_order_level_aggregation(self, lines):
        ol = features.build_order_level(lines)
        o1 = ol[ol["order_id"] == "O1"].iloc[0]
        assert o1["n_lines"] == 2
        assert o1["n_units"] == 3
        assert o1["order_value"] == pytest.approx(36.0 + 100.0)
        assert o1["basket_n_categories"] == 2
        assert bool(o1["is_multi_category"]) is True
        assert o1["basket_categories"] == "Beauty|Electronics"
        assert o1["avg_discount_rate"] == pytest.approx(4.0 / 140.0)

    def test_order_sequence_and_gap(self, lines):
        ol = features.build_order_level(lines).sort_values(["customer_id", "order_date"])
        c1 = ol[ol["customer_id"] == "C1"]
        assert list(c1["order_seq"]) == [1, 2]
        assert bool(c1["is_first_order"].iloc[0]) is True
        assert c1["days_since_prev_order"].iloc[1] == 60      # 10 Jan -> 10 Mar 2024

    def test_order_value_reconciles_to_line_revenue(self, lines):
        ol = features.build_order_level(lines)
        assert ol["order_value"].sum() == pytest.approx(lines["net_revenue"].sum())

    def test_rfm_segment_labels(self):
        assert features.rfm_segment_label(5, 5) == "Champions"
        assert features.rfm_segment_label(4, 4) == "Champions"
        assert features.rfm_segment_label(3, 3) == "Loyal Customers"
        assert features.rfm_segment_label(5, 1) == "New / Promising"
        assert features.rfm_segment_label(1, 5) == "Can't Lose Them"
        assert features.rfm_segment_label(1, 1) == "Hibernating"

    def test_clv_formula(self):
        cf = pd.DataFrame(
            {
                "customer_id": ["A", "B", "C", "D"],
                "frequency": [4, 2, 1, 1],
                "margin_per_order": [100.0, 50.0, 25.0, 10.0],
                "orders_per_year": [2.0, 1.0, 1.0, 1.0],
                "total_gross_profit": [400.0, 100.0, 25.0, 10.0],
            }
        )
        out = features.add_clv(cf, discount_rate=0.10, max_horizon_years=5.0)
        repeat_rate = 0.5                                   # 2 of 4 have >= 2 orders
        life = min(1 / (1 - repeat_rate), 5.0)              # = 2.0
        expected = 100.0 * 2.0 * life * (1 / 1.10)
        assert out["expected_life_years"].iloc[0] == pytest.approx(life)
        assert out["clv_estimate"].iloc[0] == pytest.approx(expected, abs=0.01)

    def test_cohort_matrix_month_zero_is_one(self, lines):
        ol = features.build_order_level(lines)
        m = features.build_cohort_matrix(ol, max_index=6, as_pct=True)
        assert (m[0] == 1.0).all()
        assert m.to_numpy()[~np.isnan(m.to_numpy())].max() <= 1.0 + 1e-9


# ===========================================================================
# 4. Integration: the real generated dataset
# ===========================================================================
class TestRealDataset:
    def test_raw_data_is_messy_as_advertised(self):
        if not os.path.exists(config.RAW_ORDERS):
            pytest.skip("data/raw not generated")
        raw = pd.read_csv(config.RAW_ORDERS, dtype=str)
        assert len(raw) > 45_000
        assert raw.duplicated().sum() >= 250
        assert raw.isna().sum().sum() > 0
        assert raw["order_date"].str.contains("/").any()      # D/M/Y present
        assert raw["order_date"].str.match(r"^\d{4}-").any()   # ISO present

    def test_clean_orders_has_no_nulls_and_no_duplicates(self, real_clean):
        orders, customers, products, _ = real_clean
        assert orders.isna().sum().sum() == 0
        assert customers.isna().sum().sum() == 0
        assert products.isna().sum().sum() == 0
        assert orders.duplicated().sum() == 0

    def test_clean_orders_invariants(self, real_clean):
        orders = real_clean[0]
        assert orders["order_date"].notna().all()
        assert orders["discount"].between(0, 1).all()
        assert (orders["unit_price"] > 0).all()
        assert pd.api.types.is_integer_dtype(orders["quantity"])
        for col in ("is_return", "is_price_outlier", "is_revenue_outlier"):
            assert orders[col].dtype == bool

    def test_outliers_are_flagged_not_removed(self, real_clean):
        orders, _, _, log = real_clean
        assert orders["is_price_outlier"].sum() > 0
        # every row lost is accounted for by dedupe + unusable quantity, never outliers
        lost = log.counts["orders_rows_before"] - log.counts["orders_rows_after"]
        explained = sum(r["rows_affected"] for r in log.rows
                        if r["table"] == "orders" and "dropped" in r["action_taken"])
        assert lost == explained

    def test_cleaning_is_idempotent_on_real_data(self, real_clean):
        orders, customers, products, _ = real_clean
        pd.testing.assert_frame_equal(orders, cleaning.clean_orders(orders, customers, products))
        pd.testing.assert_frame_equal(customers, cleaning.clean_customers(customers))
        pd.testing.assert_frame_equal(products, cleaning.clean_products(products))

    def test_feature_frames_line_up(self, real_features):
        lines, order_level, customer_level = real_features
        assert order_level["order_id"].nunique() == lines["order_id"].nunique()
        assert customer_level["customer_id"].nunique() == lines["customer_id"].nunique()
        assert order_level["order_value"].sum() == pytest.approx(lines["net_revenue"].sum(), rel=1e-9)
        assert customer_level["monetary"].sum() == pytest.approx(order_level["order_value"].sum(),
                                                                 rel=1e-9)

    def test_rfm_scores_span_all_five_quintiles(self, real_features):
        cl = real_features[2]
        for col in ("R", "F", "M"):
            assert set(cl[col].unique()) == {1, 2, 3, 4, 5}

    def test_churn_flag_is_consistent_with_threshold(self, real_features):
        cl = real_features[2]
        assert (cl["is_churn_risk"] == (cl["recency_days"] > cl["churn_threshold_days"])).all()
        assert cl["is_churn_risk"].mean() < 0.9      # not everyone is "at risk"

    def test_pareto_curve_is_monotonic_and_complete(self, real_features):
        lines = real_features[0]
        prod = analysis.product_performance(lines)
        assert prod["cum_revenue_share"].is_monotonic_increasing
        assert prod["cum_revenue_share"].iloc[-1] == pytest.approx(1.0, abs=1e-9)

    def test_monthly_revenue_reconciles_to_total(self, real_features):
        lines, order_level, _ = real_features
        monthly = analysis.revenue_trend(lines, order_level)
        assert monthly["net_revenue"].sum() == pytest.approx(lines["net_revenue"].sum(), rel=1e-9)
        assert len(monthly) == 36                  # three full years

    def test_statistical_tests_report_valid_p_values(self, real_features):
        lines, order_level, customer_level = real_features
        for t in analysis.run_statistical_tests(lines, order_level, customer_level):
            assert 0.0 <= t["p_value"] <= 1.0
            assert isinstance(t["interpretation"], str) and len(t["interpretation"]) > 80
            assert t["significant"] == (t["p_value"] < config.ALPHA)
