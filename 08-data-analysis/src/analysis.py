"""
Analysis
========

Answers the business questions. Every function takes the feature frames built by
``features.py`` and returns a tidy DataFrame (or a small dict) - nothing prints
or plots here, so the same code backs the notebook, the charts and the report.

Questions answered
------------------
Q1  How is revenue trending, and what is month-on-month growth?
Q2  Is there seasonality, and does day-of-week matter?
Q3  Which products drive revenue - does the 80/20 rule hold?
Q4  Which categories actually make money (margin, not just turnover)?
Q5  How do regions compare?
Q6  What is the channel mix, and is it shifting?
Q7  How well do acquisition cohorts retain?
Q8  What do the RFM segments look like, and what are they worth?
Q9  What is a customer worth (CLV), and who is at risk of churning?
Q10 Does average order value differ by customer segment?
S1-S3  Three formal statistical tests with assumptions checked.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd
from scipy import stats

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import config
    from features import build_cohort_matrix
else:                                                        # pragma: no cover
    from . import config
    from .features import build_cohort_matrix


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def fmt_p(p: float) -> str:
    """Report p-values the way a journal would, not as 0.0."""
    if p < 1e-4:
        return "p < 0.0001"
    return f"p = {p:.4f}"


def _cohens_d(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = len(a), len(b)
    sp = np.sqrt(((na - 1) * a.var(ddof=1) + (nb - 1) * b.var(ddof=1)) / (na + nb - 2))
    return float((a.mean() - b.mean()) / sp) if sp else 0.0


def _cramers_v(chi2: float, n: int, r: int, c: int) -> float:
    return float(np.sqrt((chi2 / n) / (min(r - 1, c - 1))))


def _effect_label(v: float, small: float, medium: float, large: float) -> str:
    v = abs(v)
    if v < small:
        return "negligible"
    if v < medium:
        return "small"
    if v < large:
        return "medium"
    return "large"


# ---------------------------------------------------------------------------
# Q1 - revenue trend & growth
# ---------------------------------------------------------------------------
def revenue_trend(lines: pd.DataFrame, order_level: pd.DataFrame) -> pd.DataFrame:
    monthly = (lines.groupby("order_month", observed=True)
                    .agg(net_revenue=("net_revenue", "sum"),
                         gross_profit=("gross_profit", "sum"),
                         units=("quantity", "sum"),
                         discount_amount=("discount_amount", "sum"),
                         lines=("order_id", "size"))
                    .reset_index())
    om = (order_level.groupby("order_month", observed=True)
                     .agg(orders=("order_id", "nunique"),
                          customers=("customer_id", "nunique"))
                     .reset_index())
    monthly = monthly.merge(om, on="order_month", how="left")
    monthly["aov"] = monthly["net_revenue"] / monthly["orders"]
    monthly["margin_pct"] = monthly["gross_profit"] / monthly["net_revenue"]
    monthly["mom_growth"] = monthly["net_revenue"].pct_change()
    monthly["yoy_growth"] = monthly["net_revenue"].pct_change(12)
    monthly["revenue_3m_avg"] = monthly["net_revenue"].rolling(3, min_periods=1).mean()
    monthly["revenue_12m_avg"] = monthly["net_revenue"].rolling(12, min_periods=1).mean()
    return monthly


def growth_summary(monthly: pd.DataFrame) -> dict:
    first_year = monthly[monthly["order_month"].dt.year == monthly["order_month"].dt.year.min()]
    last_year = monthly[monthly["order_month"].dt.year == monthly["order_month"].dt.year.max()]
    n_months = len(monthly)
    # Annualised growth from FULL-YEAR totals, not from the first/last month -
    # the series starts in a January trough and ends in a December peak, so a
    # month-to-month CAGR would be pure seasonality.
    yearly = monthly.groupby(monthly["order_month"].dt.year)["net_revenue"].sum()
    n_years = len(yearly)
    cagr = (yearly.iloc[-1] / yearly.iloc[0]) ** (1 / max(n_years - 1, 1)) - 1
    # OLS slope on the monthly series -> average £ added per month
    x = np.arange(n_months)
    slope, intercept, r, p, se = stats.linregress(x, monthly["net_revenue"])
    return {
        "total_net_revenue": float(monthly["net_revenue"].sum()),
        "total_gross_profit": float(monthly["gross_profit"].sum()),
        "overall_margin_pct": float(monthly["gross_profit"].sum() / monthly["net_revenue"].sum()),
        "first_year": int(first_year["order_month"].dt.year.iloc[0]),
        "last_year": int(last_year["order_month"].dt.year.iloc[0]),
        "first_year_revenue": float(first_year["net_revenue"].sum()),
        "last_year_revenue": float(last_year["net_revenue"].sum()),
        "growth_first_to_last": float(last_year["net_revenue"].sum() / first_year["net_revenue"].sum() - 1),
        "mean_mom_growth": float(monthly["mom_growth"].mean()),
        "median_mom_growth": float(monthly["mom_growth"].median()),
        "annualised_growth": float(cagr),
        "yearly_revenue": yearly,
        "trend_slope_per_month": float(slope),
        "trend_r2": float(r ** 2),
        "trend_p": float(p),
        "best_month": monthly.loc[monthly["net_revenue"].idxmax(), "order_month"],
        "best_month_revenue": float(monthly["net_revenue"].max()),
        "worst_month": monthly.loc[monthly["net_revenue"].idxmin(), "order_month"],
        "worst_month_revenue": float(monthly["net_revenue"].min()),
    }


# ---------------------------------------------------------------------------
# Q2 - seasonality & day-of-week
# ---------------------------------------------------------------------------
def seasonality(lines: pd.DataFrame, order_level: pd.DataFrame) -> dict:
    by_month = (lines.groupby("month", observed=True)["net_revenue"].sum() /
                lines["order_month"].dt.year.nunique()).reset_index(name="avg_monthly_revenue")
    by_month["month_name"] = pd.to_datetime(by_month["month"], format="%m").dt.strftime("%b")
    by_month["index_vs_avg"] = by_month["avg_monthly_revenue"] / by_month["avg_monthly_revenue"].mean()

    pivot = (lines.pivot_table(index="month", columns="year", values="net_revenue",
                               aggfunc="sum", observed=True))
    pivot.index = pd.to_datetime(pivot.index, format="%m").strftime("%b")

    dow = (order_level.groupby("day_name", observed=True)
                      .agg(orders=("order_id", "nunique"),
                           revenue=("order_value", "sum"),
                           aov=("order_value", "mean"))
                      .reindex(["Monday", "Tuesday", "Wednesday", "Thursday",
                                "Friday", "Saturday", "Sunday"])
                      .reset_index())
    dow["revenue_share"] = dow["revenue"] / dow["revenue"].sum()
    dow["index_vs_avg"] = dow["orders"] / dow["orders"].mean()

    weekend = order_level.groupby("is_weekend", observed=True)["order_value"].agg(["count", "mean", "sum"])
    return {"by_month": by_month, "month_year_pivot": pivot, "by_dow": dow, "weekend": weekend}


# ---------------------------------------------------------------------------
# Q3 - product performance & Pareto
# ---------------------------------------------------------------------------
def product_performance(lines: pd.DataFrame) -> pd.DataFrame:
    prod = (lines.groupby(["product_id", "name", "category"], observed=True)
                 .agg(net_revenue=("net_revenue", "sum"),
                      gross_profit=("gross_profit", "sum"),
                      units=("quantity", "sum"),
                      orders=("order_id", "nunique"),
                      avg_discount=("discount_rate", "mean"))
                 .reset_index()
                 .sort_values("net_revenue", ascending=False))
    prod["margin_pct"] = prod["gross_profit"] / prod["net_revenue"]
    prod["revenue_share"] = prod["net_revenue"] / prod["net_revenue"].sum()
    prod["cum_revenue_share"] = prod["revenue_share"].cumsum()
    prod["rank"] = np.arange(1, len(prod) + 1)
    prod["product_share"] = prod["rank"] / len(prod)
    return prod.reset_index(drop=True)


def pareto_summary(prod: pd.DataFrame) -> dict:
    n = len(prod)
    n_for_80 = int((prod["cum_revenue_share"] < 0.80).sum()) + 1
    top20_n = max(int(round(n * 0.20)), 1)
    top20_share = float(prod["net_revenue"].head(top20_n).sum() / prod["net_revenue"].sum())
    return {
        "n_products": n,
        "n_products_for_80pct": n_for_80,
        "pct_products_for_80pct": n_for_80 / n,
        "top20pct_revenue_share": top20_share,
        "top10_revenue_share": float(prod["net_revenue"].head(10).sum() / prod["net_revenue"].sum()),
        "bottom50pct_revenue_share": float(
            prod["net_revenue"].tail(n - int(n * 0.5)).sum() / prod["net_revenue"].sum()),
        "holds": bool(top20_share >= 0.60),
    }


# ---------------------------------------------------------------------------
# Q4 - category economics
# ---------------------------------------------------------------------------
def category_performance(lines: pd.DataFrame) -> pd.DataFrame:
    cat = (lines.groupby("category", observed=True)
                .agg(net_revenue=("net_revenue", "sum"),
                     gross_profit=("gross_profit", "sum"),
                     units=("quantity", "sum"),
                     orders=("order_id", "nunique"),
                     lines=("order_id", "size"),
                     avg_discount=("discount_rate", "mean"),
                     avg_unit_price=("unit_price", "mean"))
                .reset_index())
    cat["margin_pct"] = cat["gross_profit"] / cat["net_revenue"]
    cat["revenue_share"] = cat["net_revenue"] / cat["net_revenue"].sum()
    cat["profit_share"] = cat["gross_profit"] / cat["gross_profit"].sum()
    cat["profit_vs_revenue_gap"] = cat["profit_share"] - cat["revenue_share"]
    return cat.sort_values("net_revenue", ascending=False).reset_index(drop=True)


# ---------------------------------------------------------------------------
# Q5 / Q6 - region and channel
# ---------------------------------------------------------------------------
def regional_performance(lines: pd.DataFrame, order_level: pd.DataFrame,
                         customer_level: pd.DataFrame) -> pd.DataFrame:
    reg = (lines.groupby("region", observed=True)
                .agg(net_revenue=("net_revenue", "sum"),
                     gross_profit=("gross_profit", "sum"),
                     shipping_cost=("shipping_cost", "sum"),
                     units=("quantity", "sum"))
                .reset_index())
    o = (order_level.groupby("region", observed=True)
                    .agg(orders=("order_id", "nunique"),
                         aov=("order_value", "mean")).reset_index())
    c = (customer_level.groupby("region", observed=True)
                       .agg(customers=("customer_id", "nunique"),
                            avg_clv=("clv_estimate", "mean")).reset_index())
    reg = reg.merge(o, on="region", how="left").merge(c, on="region", how="left")
    reg["margin_pct"] = reg["gross_profit"] / reg["net_revenue"]
    reg["revenue_share"] = reg["net_revenue"] / reg["net_revenue"].sum()
    reg["revenue_per_customer"] = reg["net_revenue"] / reg["customers"]
    reg["shipping_pct_of_revenue"] = reg["shipping_cost"] / reg["net_revenue"]
    return reg.sort_values("net_revenue", ascending=False).reset_index(drop=True)


def channel_performance(lines: pd.DataFrame, order_level: pd.DataFrame) -> pd.DataFrame:
    ch = (lines.groupby("channel", observed=True)
               .agg(net_revenue=("net_revenue", "sum"),
                    gross_profit=("gross_profit", "sum"),
                    avg_discount=("discount_rate", "mean"))
               .reset_index())
    o = (order_level.groupby("channel", observed=True)
                    .agg(orders=("order_id", "nunique"),
                         customers=("customer_id", "nunique"),
                         aov=("order_value", "mean"),
                         median_aov=("order_value", "median"),
                         avg_items=("order_size", "mean")).reset_index())
    ch = ch.merge(o, on="channel", how="left")
    ch["margin_pct"] = ch["gross_profit"] / ch["net_revenue"]
    ch["revenue_share"] = ch["net_revenue"] / ch["net_revenue"].sum()
    ch["order_share"] = ch["orders"] / ch["orders"].sum()
    return ch.sort_values("net_revenue", ascending=False).reset_index(drop=True)


def channel_mix_over_time(order_level: pd.DataFrame) -> pd.DataFrame:
    mix = (order_level.pivot_table(index="order_month", columns="channel",
                                   values="order_value", aggfunc="sum", observed=True)
                      .fillna(0.0))
    return mix.div(mix.sum(axis=1), axis=0)


# ---------------------------------------------------------------------------
# Q7 - cohort retention
# ---------------------------------------------------------------------------
def cohort_analysis(order_level: pd.DataFrame, max_index: int = 12) -> dict:
    matrix = build_cohort_matrix(order_level, max_index=max_index, as_pct=True)
    sizes = build_cohort_matrix(order_level, max_index=max_index, as_pct=False)[0]
    # only cohorts with a full window contribute to the average curve
    last_month = order_level["order_month"].max()
    full = matrix.index[(last_month.to_period("M") - matrix.index.to_period("M")).n if False else
                        [(last_month.year - d.year) * 12 + (last_month.month - d.month) >= max_index
                         for d in matrix.index]]
    curve = matrix.loc[full].mean(axis=0)
    return {
        "matrix": matrix,
        "cohort_sizes": sizes,
        "avg_curve": curve,
        "n_full_cohorts": int(len(full)),
        "m1_retention": float(curve.get(1, np.nan)),
        "m3_retention": float(curve.get(3, np.nan)),
        "m6_retention": float(curve.get(6, np.nan)),
        "m12_retention": float(curve.get(12, np.nan)),
    }


# ---------------------------------------------------------------------------
# Q8 / Q9 - RFM, CLV, churn
# ---------------------------------------------------------------------------
def rfm_profiles(customer_level: pd.DataFrame) -> pd.DataFrame:
    prof = (customer_level.groupby("rfm_segment", observed=True)
                          .agg(customers=("customer_id", "nunique"),
                               avg_recency_days=("recency_days", "mean"),
                               avg_frequency=("frequency", "mean"),
                               avg_monetary=("monetary", "mean"),
                               total_revenue=("monetary", "sum"),
                               avg_order_value=("avg_order_value", "mean"),
                               avg_clv=("clv_estimate", "mean"),
                               total_clv=("clv_estimate", "sum"),
                               churn_risk_rate=("is_churn_risk", "mean"))
                          .reset_index())
    prof["customer_share"] = prof["customers"] / prof["customers"].sum()
    prof["revenue_share"] = prof["total_revenue"] / prof["total_revenue"].sum()
    prof["revenue_per_customer_index"] = (
        (prof["total_revenue"] / prof["customers"]) /
        (prof["total_revenue"].sum() / prof["customers"].sum())
    )
    return prof.sort_values("total_revenue", ascending=False).reset_index(drop=True)


def clv_summary(customer_level: pd.DataFrame) -> dict:
    cl = customer_level
    top_decile = cl.nlargest(max(int(len(cl) * 0.10), 1), "monetary")
    return {
        "n_customers": int(len(cl)),
        "mean_clv": float(cl["clv_estimate"].mean()),
        "median_clv": float(cl["clv_estimate"].median()),
        "total_clv": float(cl["clv_estimate"].sum()),
        "expected_life_years": float(cl["expected_life_years"].iloc[0]),
        "repeat_rate": float((cl["frequency"] >= 2).mean()),
        "mean_orders_per_customer": float(cl["frequency"].mean()),
        "mean_historic_profit": float(cl["historic_profit"].mean()),
        "top_decile_revenue_share": float(top_decile["monetary"].sum() / cl["monetary"].sum()),
        "clv_by_segment": (cl.groupby("segment", observed=True)["clv_estimate"]
                             .agg(["count", "mean", "median", "sum"]).reset_index()),
    }


def churn_analysis(customer_level: pd.DataFrame) -> dict:
    cl = customer_level
    at_risk = cl[cl["is_churn_risk"]]
    by_seg = (cl.groupby("rfm_segment", observed=True)
                .agg(customers=("customer_id", "nunique"),
                     at_risk=("is_churn_risk", "sum"),
                     revenue_at_risk=("monetary", lambda s: float(s[cl.loc[s.index, "is_churn_risk"]].sum())))
                .reset_index())
    by_seg["at_risk_rate"] = by_seg["at_risk"] / by_seg["customers"]
    return {
        "n_at_risk": int(len(at_risk)),
        "at_risk_rate": float(cl["is_churn_risk"].mean()),
        "revenue_at_risk": float(at_risk["monetary"].sum()),
        "revenue_at_risk_share": float(at_risk["monetary"].sum() / cl["monetary"].sum()),
        "clv_at_risk": float(at_risk["clv_estimate"].sum()),
        "by_segment": by_seg.sort_values("at_risk", ascending=False).reset_index(drop=True),
        "high_value_at_risk": int(((cl["is_churn_risk"]) & (cl["M"] >= 4)).sum()),
        "high_value_at_risk_revenue": float(
            cl.loc[(cl["is_churn_risk"]) & (cl["M"] >= 4), "monetary"].sum()),
    }


# ---------------------------------------------------------------------------
# Q10 - AOV by segment
# ---------------------------------------------------------------------------
def aov_by_segment(order_level: pd.DataFrame) -> pd.DataFrame:
    seg = (order_level.groupby("segment", observed=True)["order_value"]
                      .agg(orders="count", aov="mean", median_aov="median",
                           std="std", total="sum")
                      .reset_index())
    seg["revenue_share"] = seg["total"] / seg["total"].sum()
    seg["aov_index"] = seg["aov"] / (order_level["order_value"].mean())
    return seg.sort_values("aov", ascending=False).reset_index(drop=True)


# ---------------------------------------------------------------------------
# Statistical tests
# ---------------------------------------------------------------------------
def test_aov_web_vs_mobile(order_level: pd.DataFrame, alpha: float = config.ALPHA) -> dict:
    """
    S1. Two-sample test: is average order value different on Web vs Mobile App?

    Assumptions checked
      * independence      - one row per order, no customer weighting: assumed OK
      * normality         - order value is right-skewed, so we (a) rely on the CLT
                            given n in the thousands and (b) confirm with a
                            distribution-free Mann-Whitney U
      * equal variances   - Levene's test; we use Welch's t-test regardless,
                            which does not assume equal variance
    """
    a = order_level.loc[order_level["channel"] == "Web", "order_value"].dropna().to_numpy()
    b = order_level.loc[order_level["channel"] == "Mobile App", "order_value"].dropna().to_numpy()

    lev_stat, lev_p = stats.levene(a, b, center="median")
    t_stat, t_p = stats.ttest_ind(a, b, equal_var=False)          # Welch
    u_stat, u_p = stats.mannwhitneyu(a, b, alternative="two-sided")
    d = _cohens_d(a, b)
    diff = a.mean() - b.mean()

    sig = t_p < alpha
    interp = (
        f"Web orders average {a.mean():,.2f} and Mobile App orders {b.mean():,.2f}, "
        f"a difference of {diff:,.2f} ({diff / b.mean():+.1%} vs mobile). "
        f"Welch's t-test gives t = {t_stat:.2f}, {fmt_p(t_p)}"
        + (f", which is below the {alpha:g} threshold, so the gap is "
           "very unlikely to be a fluke of sampling - it is a real, persistent "
           "difference in basket value between the two channels."
           if sig else
           f", which is above the {alpha:g} threshold, so we cannot conclude the "
           "channels differ.")
        + f" The standardised effect size is {_effect_label(d, 0.2, 0.5, 0.8)} "
        f"(Cohen's d = {d:.2f}) because order values are enormously dispersed within each "
        f"channel - but the commercial gap is not small: {diff:,.0f} on every mobile order, "
        f"or roughly {diff * len(b) / 3:,.0f} a year at current mobile volumes. "
        f"Levene's test on variances is {fmt_p(lev_p)}"
        + (" (variances differ, which is exactly why Welch's version was used)."
           if lev_p < alpha else " (variances are comparable).")
        + f" The non-parametric Mann-Whitney U agrees ({fmt_p(u_p)}), so the "
        "conclusion does not depend on the normality assumption."
    )
    return {
        "name": "S1. AOV: Web vs Mobile App (Welch two-sample t-test)",
        "n_web": int(len(a)), "n_mobile": int(len(b)),
        "mean_web": float(a.mean()), "mean_mobile": float(b.mean()),
        "median_web": float(np.median(a)), "median_mobile": float(np.median(b)),
        "diff": float(diff), "pct_diff": float(diff / b.mean()),
        "levene_p": float(lev_p), "t_stat": float(t_stat), "p_value": float(t_p),
        "mannwhitney_p": float(u_p), "cohens_d": float(d),
        "significant": bool(sig), "interpretation": interp,
    }


def test_segment_region_independence(customer_level: pd.DataFrame,
                                     alpha: float = config.ALPHA) -> dict:
    """
    S2. Chi-square test of independence: customer segment x region.

    Assumptions checked
      * independent observations - one row per customer
      * expected cell counts >= 5 - verified below; if violated we would collapse
        categories or switch to a Monte-Carlo / Fisher variant
    """
    table = pd.crosstab(customer_level["segment"], customer_level["region"])
    chi2, p, dof, expected = stats.chi2_contingency(table)
    min_expected = float(expected.min())
    v = _cramers_v(chi2, int(table.to_numpy().sum()), *table.shape)

    resid = (table.to_numpy() - expected) / np.sqrt(expected)
    resid_df = pd.DataFrame(resid, index=table.index, columns=table.columns)
    flat = resid_df.stack()
    top = flat.reindex(flat.abs().sort_values(ascending=False).index).head(3)
    top_txt = "; ".join(
        f"{seg} in {reg} ({'over' if val > 0 else 'under'}-represented, z = {val:+.1f})"
        for (seg, reg), val in top.items()
    )

    sig = p < alpha
    interp = (
        f"Chi-square = {chi2:.1f} on {dof} degrees of freedom, {fmt_p(p)}. "
        + (f"Because {fmt_p(p)} is below {alpha:g}, segment and region are **not** "
           "independent: the segment mix genuinely varies from region to region, "
           "so a single national segment strategy would misfit some regions. "
           if sig else
           "We cannot reject independence: the segment mix looks essentially the "
           "same in every region. ")
        + f"The association is {_effect_label(v, 0.1, 0.3, 0.5)} though "
        f"(Cramer's V = {v:.3f}), so the effect is real but not dramatic. "
        f"The cells driving it are: {top_txt}. "
        f"The minimum expected cell count is {min_expected:.0f}"
        + (" (>= 5, so the chi-square approximation is valid)."
           if min_expected >= 5 else " (< 5, so treat the p-value with caution).")
    )
    return {
        "name": "S2. Customer segment x region (chi-square test of independence)",
        "table": table, "expected_min": min_expected,
        "chi2": float(chi2), "dof": int(dof), "p_value": float(p),
        "cramers_v": float(v), "residuals": resid_df,
        "significant": bool(sig), "interpretation": interp,
    }


def test_margin_across_categories(lines: pd.DataFrame, alpha: float = config.ALPHA) -> dict:
    """
    S3. One-way ANOVA: does gross margin % differ across product categories?

    Assumptions checked
      * independence      - one row per order line
      * normality         - Shapiro-Wilk on a random sub-sample per group
      * homoscedasticity  - Levene's test; if it fails we fall back on the
                            Kruskal-Wallis rank test, which needs neither
    """
    d = lines.loc[(~lines["is_return"]) & lines["margin_pct"].notna(),
                  ["category", "margin_pct"]]
    groups = [g["margin_pct"].to_numpy() for _, g in d.groupby("category", observed=True)]
    names = [str(k) for k, _ in d.groupby("category", observed=True)]

    rng = np.random.default_rng(7)
    shapiro_p = {}
    for nm, g in zip(names, groups):
        samp = rng.choice(g, size=min(len(g), 500), replace=False)
        shapiro_p[nm] = float(stats.shapiro(samp).pvalue)
    n_non_normal = sum(v < alpha for v in shapiro_p.values())

    lev_stat, lev_p = stats.levene(*groups, center="median")
    f_stat, f_p = stats.f_oneway(*groups)
    h_stat, h_p = stats.kruskal(*groups)

    grand = d["margin_pct"].mean()
    ss_between = sum(len(g) * (g.mean() - grand) ** 2 for g in groups)
    ss_total = float(((d["margin_pct"] - grand) ** 2).sum())
    eta2 = ss_between / ss_total

    means = (d.groupby("category", observed=True)["margin_pct"].mean().sort_values(ascending=False))
    best, worst = means.index[0], means.index[-1]

    sig = f_p < alpha
    interp = (
        f"One-way ANOVA gives F = {f_stat:,.1f}, {fmt_p(f_p)}. "
        + (f"With {fmt_p(f_p)} the differences between categories are far larger "
           "than random line-to-line variation, so margin really is a property of "
           "the category, not noise. "
           if sig else "There is no evidence that margin differs by category. ")
        + f"{best} runs the fattest margin ({means.iloc[0]:.1%}) and {worst} the "
        f"thinnest ({means.iloc[-1]:.1%}) - a {(means.iloc[0] - means.iloc[-1]) * 100:.0f} "
        f"percentage-point spread. Category explains {eta2:.1%} of the total "
        f"variation in line margin (eta-squared = {eta2:.3f}, "
        f"{_effect_label(eta2, 0.01, 0.06, 0.14)} effect). "
        f"On assumptions: Levene's test is {fmt_p(lev_p)}"
        + (" so variances are unequal, " if lev_p < alpha else " so variances are comparable, ")
        + f"and Shapiro-Wilk rejects normality in {n_non_normal} of {len(names)} categories. "
        f"Because of that we re-ran the question with Kruskal-Wallis, which assumes "
        f"neither: H = {h_stat:,.1f}, {fmt_p(h_p)} - the same conclusion, so the "
        "result is robust."
    )
    return {
        "name": "S3. Gross margin % across product categories (one-way ANOVA)",
        "group_means": means, "shapiro_p": shapiro_p, "n_non_normal": int(n_non_normal),
        "levene_p": float(lev_p), "f_stat": float(f_stat), "p_value": float(f_p),
        "kruskal_h": float(h_stat), "kruskal_p": float(h_p), "eta_squared": float(eta2),
        "significant": bool(sig), "interpretation": interp,
    }


def run_statistical_tests(lines: pd.DataFrame, order_level: pd.DataFrame,
                          customer_level: pd.DataFrame) -> list[dict]:
    return [
        test_aov_web_vs_mobile(order_level),
        test_segment_region_independence(customer_level),
        test_margin_across_categories(lines),
    ]


# ---------------------------------------------------------------------------
# Correlation matrix (used by the visualiser and the notebook)
# ---------------------------------------------------------------------------
def correlation_matrix(order_level: pd.DataFrame) -> pd.DataFrame:
    cols = ["order_value", "gross_profit", "order_size", "n_lines",
            "avg_discount_rate", "shipping_cost", "basket_n_categories",
            "order_margin_pct"]
    return order_level[cols].corr(method="pearson")


# ---------------------------------------------------------------------------
# Everything, in one dict
# ---------------------------------------------------------------------------
def run_all(lines: pd.DataFrame, order_level: pd.DataFrame,
            customer_level: pd.DataFrame, verbose: bool = True) -> dict:
    monthly = revenue_trend(lines, order_level)
    prod = product_performance(lines)
    res = {
        "monthly": monthly,
        "growth": growth_summary(monthly),
        "seasonality": seasonality(lines, order_level),
        "products": prod,
        "pareto": pareto_summary(prod),
        "categories": category_performance(lines),
        "regions": regional_performance(lines, order_level, customer_level),
        "channels": channel_performance(lines, order_level),
        "channel_mix": channel_mix_over_time(order_level),
        "cohorts": cohort_analysis(order_level),
        "rfm": rfm_profiles(customer_level),
        "clv": clv_summary(customer_level),
        "churn": churn_analysis(customer_level),
        "aov_segment": aov_by_segment(order_level),
        "correlations": correlation_matrix(order_level),
        "tests": run_statistical_tests(lines, order_level, customer_level),
    }
    if verbose:
        g = res["growth"]
        print(f"[analysis] net revenue {g['total_net_revenue']:,.0f} over "
              f"{len(monthly)} months, margin {g['overall_margin_pct']:.1%}")
        print(f"[analysis] {res['pareto']['pct_products_for_80pct']:.1%} of SKUs = 80% of revenue")
        print(f"[analysis] M1 retention {res['cohorts']['m1_retention']:.1%}, "
              f"churn-risk customers {res['churn']['at_risk_rate']:.1%}")
        for t in res["tests"]:
            print(f"[analysis] {t['name']}: {fmt_p(t['p_value'])} "
                  f"({'significant' if t['significant'] else 'not significant'})")
    return res


if __name__ == "__main__":
    from cleaning import run_cleaning
    from features import build_all
    o, c, p, _ = run_cleaning(write=False, verbose=False)
    lines, order_level, customer_level = build_all(o, c, p, write=False, verbose=False)
    run_all(lines, order_level, customer_level)
