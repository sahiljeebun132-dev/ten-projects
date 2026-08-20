"""
Feature engineering
===================

Builds the three analytical grains the rest of the project works on:

``order_lines``   one row per order line  - money, margin, calendar and joined
                  product/customer attributes
``order_level``   one row per ``order_id`` - basket size, basket categories,
                  order value, blended discount
``customer_level``one row per customer    - RFM, cohort, tenure, CLV, churn risk

Money definitions used consistently everywhere
----------------------------------------------
    gross_revenue    = quantity * unit_price                  (before discount)
    discount_amount  = gross_revenue * discount
    net_revenue      = gross_revenue - discount_amount        ("revenue")
    cogs             = quantity * product.cost
    gross_profit     = net_revenue - cogs
    contribution     = gross_profit - shipping_cost
    margin_pct       = gross_profit / net_revenue

Returns carry a negative ``quantity``, so they flow through as negative
revenue and negative profit - i.e. every headline figure is a **net** figure.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import config
else:                                                        # pragma: no cover
    from . import config


# ---------------------------------------------------------------------------
# 1. Order-line grain
# ---------------------------------------------------------------------------
def add_money_features(lines: pd.DataFrame) -> pd.DataFrame:
    """Revenue / margin / discount columns. Requires `cost` to be joined already."""
    df = lines.copy()
    df["gross_revenue"] = (df["quantity"] * df["unit_price"]).round(2)
    df["discount_amount"] = (df["gross_revenue"] * df["discount"]).round(2)
    df["net_revenue"] = (df["gross_revenue"] - df["discount_amount"]).round(2)
    df["cogs"] = (df["quantity"] * df["cost"]).round(2)
    df["gross_profit"] = (df["net_revenue"] - df["cogs"]).round(2)
    df["contribution"] = (df["gross_profit"] - df["shipping_cost"]).round(2)
    df["margin_pct"] = np.where(df["net_revenue"] != 0,
                                df["gross_profit"] / df["net_revenue"], np.nan)
    df["discount_rate"] = df["discount"]
    df["units"] = df["quantity"]
    return df


def add_calendar_features(df: pd.DataFrame, date_col: str = "order_date") -> pd.DataFrame:
    """Year / month / quarter / weekday helpers used by the seasonality analysis."""
    out = df.copy()
    d = out[date_col]
    out["year"] = d.dt.year
    out["month"] = d.dt.month
    out["month_name"] = d.dt.strftime("%b")
    out["order_month"] = d.dt.to_period("M").dt.to_timestamp()
    out["quarter"] = d.dt.quarter
    out["year_quarter"] = d.dt.year.astype(str) + "-Q" + d.dt.quarter.astype(str)
    out["day_of_week"] = d.dt.dayofweek                       # Mon=0
    out["day_name"] = d.dt.day_name()
    out["is_weekend"] = out["day_of_week"] >= 5
    out["week"] = d.dt.isocalendar().week.astype(int)
    return out


def build_order_lines(orders: pd.DataFrame,
                      customers: pd.DataFrame,
                      products: pd.DataFrame) -> pd.DataFrame:
    """Join the three cleaned tables and derive every line-level feature."""
    prod_cols = ["product_id", "name", "category", "subcategory", "cost", "list_price", "supplier"]
    cust_cols = ["customer_id", "signup_date", "age", "gender", "city", "region", "segment"]

    df = orders.merge(products[prod_cols], on="product_id", how="left", validate="many_to_one")
    df = df.merge(customers[cust_cols].rename(columns={"region": "customer_region"}),
                  on="customer_id", how="left", validate="many_to_one")

    df = add_money_features(df)
    df = add_calendar_features(df)

    # tenure at the moment of the order (negative => order predates signup record)
    df["tenure_days"] = (df["order_date"] - df["signup_date"]).dt.days
    df["tenure_months"] = (df["tenure_days"] / 30.44).round(1)

    # cohort = month of the customer's FIRST purchase (behavioural, not signup,
    # because a signup with no purchase never enters a revenue cohort)
    first_order = df.groupby("customer_id", observed=True)["order_date"].transform("min")
    df["first_order_date"] = first_order
    df["cohort_month"] = first_order.dt.to_period("M").dt.to_timestamp()
    df["cohort_index"] = (
        (df["order_month"].dt.year - df["cohort_month"].dt.year) * 12
        + (df["order_month"].dt.month - df["cohort_month"].dt.month)
    )
    df["is_first_order_month"] = df["cohort_index"] == 0
    return df


# ---------------------------------------------------------------------------
# 2. Order grain
# ---------------------------------------------------------------------------
def build_order_level(lines: pd.DataFrame) -> pd.DataFrame:
    """Collapse lines to orders: order value, size, and the basket's categories."""
    g = lines.groupby("order_id", observed=True)
    out = g.agg(
        customer_id=("customer_id", "first"),
        order_date=("order_date", "first"),
        order_month=("order_month", "first"),
        year=("year", "first"),
        month=("month", "first"),
        day_of_week=("day_of_week", "first"),
        day_name=("day_name", "first"),
        is_weekend=("is_weekend", "first"),
        channel=("channel", "first"),
        payment_method=("payment_method", "first"),
        region=("region", "first"),
        segment=("segment", "first"),
        n_lines=("product_id", "size"),
        n_units=("quantity", "sum"),
        order_value=("net_revenue", "sum"),
        gross_revenue=("gross_revenue", "sum"),
        discount_amount=("discount_amount", "sum"),
        gross_profit=("gross_profit", "sum"),
        shipping_cost=("shipping_cost", "sum"),
        contains_return=("is_return", "any"),
    ).reset_index()

    out["order_size"] = out["n_units"]                      # units in the basket
    out["avg_discount_rate"] = np.where(out["gross_revenue"] != 0,
                                        out["discount_amount"] / out["gross_revenue"], 0.0)
    out["order_margin_pct"] = np.where(out["order_value"] != 0,
                                       out["gross_profit"] / out["order_value"], np.nan)

    # basket categories: how many distinct categories, and the full sorted set
    cats = (lines.groupby("order_id", observed=True)["category"]
                 .agg(basket_n_categories="nunique",
                      basket_categories=lambda s: "|".join(sorted(set(s.dropna()))))
                 .reset_index())
    out = out.merge(cats, on="order_id", how="left")
    out["is_multi_category"] = out["basket_n_categories"] > 1

    # nth order of that customer -> repeat-purchase behaviour
    out = out.sort_values(["customer_id", "order_date", "order_id"])
    out["order_seq"] = out.groupby("customer_id", observed=True).cumcount() + 1
    out["is_first_order"] = out["order_seq"] == 1
    out["days_since_prev_order"] = (
        out.groupby("customer_id", observed=True)["order_date"].diff().dt.days
    )
    return out.reset_index(drop=True)


# ---------------------------------------------------------------------------
# 3. Customer grain: RFM, cohort, tenure, CLV, churn risk
# ---------------------------------------------------------------------------
def _quintile_score(s: pd.Series, ascending: bool = True) -> pd.Series:
    """
    1-5 quintile score.  Ranked with ``method='first'`` before cutting so that
    heavily tied columns (e.g. frequency, where most customers have 1-3 orders)
    still split into five non-empty buckets instead of collapsing.
    """
    ranked = s.rank(method="first", ascending=ascending)
    return pd.qcut(ranked, 5, labels=[1, 2, 3, 4, 5]).astype(int)


def rfm_segment_label(r: int, fm: int) -> str:
    """
    Map an (R, FM) pair onto the standard 8-box RFM naming used in CRM practice.
    ``fm`` is the rounded average of the Frequency and Monetary scores.
    """
    if r >= 4 and fm >= 4:
        return "Champions"
    if r >= 3 and fm >= 3:
        return "Loyal Customers"
    if r >= 4 and fm <= 2:
        return "New / Promising"
    if r == 3 and fm <= 2:
        return "Potential Loyalist"
    if r == 2 and fm >= 3:
        return "At Risk"
    if r == 1 and fm >= 4:
        return "Can't Lose Them"
    if r <= 2 and fm <= 2:
        return "Hibernating"
    return "Needs Attention"


def build_customer_features(lines: pd.DataFrame,
                            order_level: pd.DataFrame,
                            customers: pd.DataFrame,
                            asof: str | pd.Timestamp | None = None) -> pd.DataFrame:
    """
    One row per *purchasing* customer with RFM, cohort, tenure, CLV and churn risk.

    ``asof`` defaults to ``config.ANALYSIS_ASOF`` (the day after the last order),
    so recency is measured from a fixed, reproducible snapshot date rather than
    from "today".
    """
    asof = pd.Timestamp(asof or config.ANALYSIS_ASOF)

    g = order_level.groupby("customer_id", observed=True)
    cf = g.agg(
        first_order_date=("order_date", "min"),
        last_order_date=("order_date", "max"),
        frequency=("order_id", "nunique"),
        monetary=("order_value", "sum"),
        total_gross_profit=("gross_profit", "sum"),
        avg_order_value=("order_value", "mean"),
        median_order_value=("order_value", "median"),
        avg_order_size=("order_size", "mean"),
        avg_discount_rate=("avg_discount_rate", "mean"),
        mean_gap_days=("days_since_prev_order", "mean"),
        n_returns=("contains_return", "sum"),
    ).reset_index()

    cf["recency_days"] = (asof - cf["last_order_date"]).dt.days
    cf["cohort_month"] = cf["first_order_date"].dt.to_period("M").dt.to_timestamp()
    cf["tenure_days"] = (asof - cf["first_order_date"]).dt.days
    cf["tenure_years"] = (cf["tenure_days"] / 365.25).clip(lower=0.25)
    cf["customer_lifespan_days"] = (cf["last_order_date"] - cf["first_order_date"]).dt.days
    cf["return_rate"] = cf["n_returns"] / cf["frequency"]
    cf["margin_per_order"] = cf["total_gross_profit"] / cf["frequency"]
    cf["orders_per_year"] = cf["frequency"] / cf["tenure_years"]

    # favourite category + breadth of the relationship
    fav = (lines.groupby(["customer_id", "category"], observed=True)["net_revenue"].sum()
                .reset_index()
                .sort_values(["customer_id", "net_revenue"], ascending=[True, False])
                .groupby("customer_id", observed=True)
                .head(1)
                .rename(columns={"category": "top_category"})[["customer_id", "top_category"]])
    breadth = (lines.groupby("customer_id", observed=True)
                    .agg(n_categories=("category", "nunique"),
                         n_products=("product_id", "nunique")).reset_index())
    cf = cf.merge(fav, on="customer_id", how="left").merge(breadth, on="customer_id", how="left")

    # static attributes
    cf = cf.merge(customers[["customer_id", "signup_date", "age", "gender",
                             "city", "region", "segment"]],
                  on="customer_id", how="left")

    # ---- RFM ------------------------------------------------------------
    cf["R"] = _quintile_score(cf["recency_days"], ascending=False)   # low recency = best
    cf["F"] = _quintile_score(cf["frequency"], ascending=True)
    cf["M"] = _quintile_score(cf["monetary"], ascending=True)
    cf["RFM_score"] = cf["R"] * 100 + cf["F"] * 10 + cf["M"]
    cf["RFM_sum"] = cf["R"] + cf["F"] + cf["M"]
    cf["FM"] = ((cf["F"] + cf["M"]) / 2).round().astype(int)
    cf["rfm_segment"] = [rfm_segment_label(r, fm) for r, fm in zip(cf["R"], cf["FM"])]

    # ---- churn risk ------------------------------------------------------
    # A customer is "at risk" once they have been silent for materially longer
    # than their own established rhythm.  Repeat buyers are judged against
    # 2x their personal mean inter-purchase gap (floored at 90 days so that very
    # frequent buyers are not flagged after a fortnight); one-time buyers are
    # judged against a flat 180-day window.
    personal_threshold = np.where(
        cf["frequency"] >= 2,
        np.maximum(2 * cf["mean_gap_days"].fillna(90), 90),
        180.0,
    )
    cf["churn_threshold_days"] = personal_threshold
    cf["is_churn_risk"] = cf["recency_days"] > cf["churn_threshold_days"]
    cf["churn_risk_score"] = (cf["recency_days"] / cf["churn_threshold_days"]).round(2)

    # ---- CLV -------------------------------------------------------------
    cf = add_clv(cf)
    return cf.reset_index(drop=True)


def add_clv(cf: pd.DataFrame, discount_rate: float = 0.10,
            max_horizon_years: float = 5.0) -> pd.DataFrame:
    """
    Simple, transparent CLV.

    ``CLV = margin_per_order * orders_per_year * expected_remaining_years * d``

    * ``margin_per_order``      - realised gross profit per order (not revenue,
                                  so a heavy discounter is not rewarded).
    * ``orders_per_year``       - realised purchase frequency over the customer's
                                  observed tenure.
    * ``expected_remaining_years = 1 / (1 - retention)`` from the observed annual
      repeat rate, capped at ``max_horizon_years`` - the standard geometric
      customer-lifetime approximation.
    * ``d`` - a single-period discount factor ``1 / (1 + discount_rate)`` to
      express the future stream in today's money.

    This is a *contractual-free, non-probabilistic* estimate: it is good enough
    to rank customers and to size segments, and it is deliberately explainable.
    A BG/NBD + Gamma-Gamma model would be the next step if the ranking were
    being used for spend allocation.
    """
    out = cf.copy()
    repeat_rate = float((out["frequency"] >= 2).mean())
    expected_life = min(1.0 / max(1e-6, 1.0 - repeat_rate), max_horizon_years)
    out["expected_life_years"] = expected_life
    out["clv_estimate"] = (
        out["margin_per_order"] * out["orders_per_year"]
        * expected_life * (1.0 / (1.0 + discount_rate))
    ).round(2)
    # historic value already banked, for comparison
    out["historic_profit"] = out["total_gross_profit"].round(2)
    return out


# ---------------------------------------------------------------------------
# 4. Cohort matrix
# ---------------------------------------------------------------------------
def build_cohort_matrix(order_level: pd.DataFrame, max_index: int = 12,
                        as_pct: bool = True) -> pd.DataFrame:
    """
    Customer-retention matrix: rows = acquisition cohort (month of first order),
    columns = months since acquisition, values = % of the cohort that ordered.
    """
    df = order_level.copy()
    first = df.groupby("customer_id", observed=True)["order_date"].transform("min")
    df["cohort_month"] = first.dt.to_period("M").dt.to_timestamp()
    df["cohort_index"] = (
        (df["order_month"].dt.year - df["cohort_month"].dt.year) * 12
        + (df["order_month"].dt.month - df["cohort_month"].dt.month)
    )
    counts = (df.groupby(["cohort_month", "cohort_index"], observed=True)["customer_id"]
                .nunique().reset_index())
    matrix = counts.pivot(index="cohort_month", columns="cohort_index", values="customer_id")
    matrix = matrix.loc[:, matrix.columns <= max_index]
    if as_pct:
        matrix = matrix.div(matrix[0], axis=0)
    return matrix


# ---------------------------------------------------------------------------
def build_all(orders: pd.DataFrame, customers: pd.DataFrame, products: pd.DataFrame,
              write: bool = True, verbose: bool = True):
    lines = build_order_lines(orders, customers, products)
    order_level = build_order_level(lines)
    customer_level = build_customer_features(lines, order_level, customers)

    if write:
        config.ensure_dirs()
        lines.to_parquet(config.FEATURES_ORDERS_PARQUET, index=False)
        customer_level.to_parquet(config.CUSTOMER_FEATURES_PARQUET, index=False)
    if verbose:
        print(f"[features] lines      {len(lines):>7,} rows x {lines.shape[1]} cols")
        print(f"[features] orders     {len(order_level):>7,} rows x {order_level.shape[1]} cols")
        print(f"[features] customers  {len(customer_level):>7,} rows x {customer_level.shape[1]} cols")
    return lines, order_level, customer_level


if __name__ == "__main__":
    from cleaning import run_cleaning
    o, c, p, _ = run_cleaning(write=False, verbose=False)
    build_all(o, c, p)
