"""
Visualisation
=============

Fourteen publication-quality figures written to ``reports/figures/``.

Every chart goes through ``src/plot_style.py`` so the whole set shares one
palette (colourblind-safe Okabe-Ito), one typographic scale and one money
format.  Titles are written to state the *finding*, and the numbers inside them
are interpolated from the data - if the dataset changes, the headline changes
with it.
"""

from __future__ import annotations

import os
import sys

import matplotlib.colors as mcolors
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import config
    import plot_style as ps
    from analysis import fmt_p
else:                                                        # pragma: no cover
    from . import config
    from . import plot_style as ps
    from .analysis import fmt_p


# ---------------------------------------------------------------------------
# 1. Revenue trend with rolling mean
# ---------------------------------------------------------------------------
def fig_revenue_trend(res: dict, outdir: str) -> str:
    m = res["monthly"]
    g = res["growth"]
    fig, ax = plt.subplots()
    ax.plot(m["order_month"], m["net_revenue"], color=ps.OKABE_ITO[4], lw=1.6,
            alpha=0.9, label="Monthly net revenue")
    ax.plot(m["order_month"], m["revenue_3m_avg"], color=ps.ACCENT, lw=3.0,
            label="3-month rolling mean")
    ax.fill_between(m["order_month"], 0, m["net_revenue"], color=ps.OKABE_ITO[4], alpha=0.08)

    peak = m.loc[m["net_revenue"].idxmax()]
    ax.scatter([peak["order_month"]], [peak["net_revenue"]], color=ps.ACCENT_2, zorder=5, s=60)
    ax.annotate(f"Peak {peak['order_month']:%b %Y}\n{ps.money(peak['net_revenue'])}",
                xy=(peak["order_month"], peak["net_revenue"]),
                xytext=(-95, -6), textcoords="offset points",
                fontsize=10, color=ps.INK, ha="left",
                arrowprops=dict(arrowstyle="-", color=ps.MUTED, lw=1))
    # direct-label the two series instead of using a legend box
    ax.text(m["order_month"].iloc[-1], m["revenue_3m_avg"].iloc[-1],
            "  3-mo mean", color=ps.ACCENT, va="center", fontsize=10, fontweight="semibold")

    ps.titles(ax,
              f"Revenue grew {g['growth_first_to_last']:.0%} between {g['first_year']} and "
              f"{g['last_year']}, but the trend is entirely seasonal",
              f"Net revenue by month - {ps.money(g['total_net_revenue'])} total, "
              f"{g['annualised_growth']:.0%} annualised, R2 of the linear trend = {g['trend_r2']:.2f}")
    ax.set_xlabel("")
    ax.set_ylabel("Net revenue")
    ax.set_ylim(bottom=0)
    ps.money_axis(ax)
    ps.style_axes(ax)
    return ps.save(fig, os.path.join(outdir, "01_revenue_trend.png"))


# ---------------------------------------------------------------------------
# 2. Month-on-month growth
# ---------------------------------------------------------------------------
def fig_mom_growth(res: dict, outdir: str) -> str:
    m = res["monthly"].dropna(subset=["mom_growth"])
    colors = [ps.POSITIVE if v >= 0 else ps.NEGATIVE for v in m["mom_growth"]]
    fig, ax = plt.subplots()
    ax.bar(m["order_month"], m["mom_growth"], width=22, color=colors)
    ax.axhline(0, color=ps.MUTED, lw=1)
    mean_g = m["mom_growth"].mean()
    ax.axhline(mean_g, color=ps.INK, lw=1.4, ls="--")
    ax.text(m["order_month"].iloc[0], mean_g, f"  mean {mean_g:+.1%}",
            va="bottom", fontsize=10, color=ps.INK)

    worst = m.loc[m["mom_growth"].idxmin()]
    ax.annotate(f"{worst['order_month']:%b %Y}: {worst['mom_growth']:.0%}\n"
                "the post-Christmas cliff",
                xy=(worst["order_month"], worst["mom_growth"]),
                xytext=(12, 10), textcoords="offset points", fontsize=10,
                arrowprops=dict(arrowstyle="-", color=ps.MUTED, lw=1))

    n_down = int((m["mom_growth"] < 0).sum())
    ps.titles(ax,
              f"Growth is lumpy: {n_down} of {len(m)} months fell versus the month before",
              "Month-on-month change in net revenue - the January collapse repeats every year")
    ax.set_ylabel("MoM change")
    ax.set_xlabel("")
    ps.pct_axis(ax)
    ps.style_axes(ax)
    return ps.save(fig, os.path.join(outdir, "02_mom_growth.png"))


# ---------------------------------------------------------------------------
# 3. Monthly seasonality heatmap
# ---------------------------------------------------------------------------
def fig_seasonality_heatmap(res: dict, outdir: str) -> str:
    pivot = res["seasonality"]["month_year_pivot"] / 1000.0
    by_month = res["seasonality"]["by_month"]
    peak = by_month.loc[by_month["index_vs_avg"].idxmax()]
    trough = by_month.loc[by_month["index_vs_avg"].idxmin()]

    fig, ax = plt.subplots(figsize=(9.5, 7))
    sns.heatmap(pivot, cmap=ps.SEQ_CMAP, annot=True, fmt=".0f", linewidths=0.6,
                linecolor="white", cbar_kws={"label": "Net revenue (£k)"}, ax=ax,
                annot_kws={"fontsize": 9})
    ps.titles(ax,
              f"{peak['month_name']} runs {peak['index_vs_avg'] - 1:+.0%} above an average month; "
              f"{trough['month_name']} runs {trough['index_vs_avg'] - 1:.0%} below",
              "Net revenue by calendar month and year (£k) - the same shape repeats every year")
    ax.set_xlabel("")
    ax.set_ylabel("")
    ax.tick_params(left=False, bottom=False)
    return ps.save(fig, os.path.join(outdir, "03_seasonality_heatmap.png"))


# ---------------------------------------------------------------------------
# 4. Day-of-week effect
# ---------------------------------------------------------------------------
def fig_day_of_week(res: dict, outdir: str) -> str:
    dow = res["seasonality"]["by_dow"].copy()
    best = dow.loc[dow["orders"].idxmax()]
    worst = dow.loc[dow["orders"].idxmin()]
    colors = [ps.ACCENT if d in ("Saturday", "Sunday") else ps.OKABE_ITO[7] for d in dow["day_name"]]

    fig, ax = plt.subplots(figsize=(10, 5.6))
    bars = ax.bar(dow["day_name"], dow["orders"], color=colors, width=0.68)
    ps.label_bars(ax, bars, fmt=lambda v: f"{v:,.0f}")
    ax.axhline(dow["orders"].mean(), color=ps.MUTED, ls="--", lw=1.2)
    ax.text(6.45, dow["orders"].mean(), "avg", va="center", color=ps.MUTED, fontsize=10)

    lift = best["orders"] / worst["orders"] - 1
    ps.titles(ax,
              f"{best['day_name']} takes {lift:.0%} more orders than {worst['day_name']} - "
              "the week is a weekend business",
              f"Orders by day of week. Weekend AOV ({ps.money(dow.loc[dow['day_name'].isin(['Saturday','Sunday']),'aov'].mean())}) "
              "is no higher, so the lift is footfall, not basket size")
    ax.set_ylabel("Orders")
    ax.set_ylim(0, dow["orders"].max() * 1.16)
    ps.style_axes(ax)
    return ps.save(fig, os.path.join(outdir, "04_day_of_week.png"))


# ---------------------------------------------------------------------------
# 5. Pareto chart
# ---------------------------------------------------------------------------
def fig_pareto(res: dict, outdir: str) -> str:
    prod = res["products"]
    par = res["pareto"]
    n_show = 60
    head = prod.head(n_show)

    fig, ax = plt.subplots(figsize=(11.5, 6.2))
    ax.bar(head["rank"], head["net_revenue"], color=ps.OKABE_ITO[4], width=0.85)
    ax.set_ylabel("Net revenue per SKU")
    ax.set_xlabel(f"Products, ranked by revenue (top {n_show} of {par['n_products']} shown)")
    ps.money_axis(ax)
    ps.style_axes(ax)

    ax2 = ax.twinx()
    ax2.plot(prod["rank"], prod["cum_revenue_share"], color=ps.ACCENT, lw=2.6)
    ax2.set_ylim(0, 1.02)
    ax2.set_xlim(0, n_show + 1)
    ax2.grid(False)
    for side in ("top", "right", "left"):
        ax2.spines[side].set_visible(False)
    ps.pct_axis(ax2)
    ax2.set_ylabel("Cumulative revenue share", color=ps.ACCENT)
    ax2.tick_params(axis="y", colors=ps.ACCENT)

    n80 = par["n_products_for_80pct"]
    ax2.axhline(0.80, color=ps.MUTED, ls=":", lw=1.3)
    if n80 <= n_show:
        ax2.axvline(n80, color=ps.MUTED, ls=":", lw=1.3)
        ax2.annotate(f"{n80} SKUs ({par['pct_products_for_80pct']:.0%} of the range)\n= 80% of revenue",
                     xy=(n80, 0.80), xytext=(14, -46), textcoords="offset points",
                     fontsize=10.5, color=ps.INK,
                     arrowprops=dict(arrowstyle="->", color=ps.MUTED, lw=1))

    ps.titles(ax,
              f"The 80/20 rule is an understatement: {par['pct_products_for_80pct']:.0%} of SKUs "
              "produce 80% of revenue",
              f"Top 20% of products = {par['top20pct_revenue_share']:.0%} of revenue; "
              f"the bottom half of the range contributes {par['bottom50pct_revenue_share']:.1%}")
    return ps.save(fig, os.path.join(outdir, "05_product_pareto.png"))


# ---------------------------------------------------------------------------
# 6. Category margin box plots
# ---------------------------------------------------------------------------
def fig_category_margin_box(lines: pd.DataFrame, res: dict, outdir: str) -> str:
    d = lines[(~lines["is_return"]) & lines["margin_pct"].between(-0.6, 1.0)]
    order = (d.groupby("category", observed=True)["margin_pct"].median()
              .sort_values(ascending=False).index.tolist())
    test = [t for t in res["tests"] if t["name"].startswith("S3")][0]

    fig, ax = plt.subplots(figsize=(11, 6.2))
    sns.boxplot(data=d, x="margin_pct", y="category", order=order, ax=ax,
                showfliers=False, width=0.62, linewidth=1.1,
                palette=[ps.OKABE_ITO[i % len(ps.OKABE_ITO)] for i in range(len(order))],
                hue="category", legend=False)
    med = d.groupby("category", observed=True)["margin_pct"].median()
    for i, cat in enumerate(order):
        ax.text(1.005, i, f"{med[cat]:.0%}", transform=ax.get_yaxis_transform(),
                va="center", fontsize=10, color=ps.INK, fontweight="semibold")
    ax.axvline(d["margin_pct"].median(), color=ps.MUTED, ls="--", lw=1.2)

    ps.titles(ax,
              f"{order[0]} earns {med[order[0]]:.0%} margin, {order[-1]} only "
              f"{med[order[-1]]:.0%} - a {(med[order[0]] - med[order[-1]]) * 100:.0f} "
              "percentage-point spread",
              f"Distribution of gross margin per order line. ANOVA F = {test['f_stat']:,.0f}, "
              f"{fmt_p(test['p_value'])}; category explains "
              f"{test['eta_squared']:.0%} of the variation")
    ax.set_xlabel("Gross margin % of an order line")
    ax.set_ylabel("")
    ps.pct_axis(ax, axis="x")
    ps.style_axes(ax, xgrid=True, ygrid=False)
    return ps.save(fig, os.path.join(outdir, "06_category_margin_box.png"))


# ---------------------------------------------------------------------------
# 7. Category revenue vs margin (where the profit actually is)
# ---------------------------------------------------------------------------
def fig_category_revenue_vs_margin(res: dict, outdir: str) -> str:
    cat = res["categories"]
    fig, ax = plt.subplots(figsize=(10.5, 6.4))
    sizes = 120 + 2600 * cat["profit_share"]
    ax.scatter(cat["net_revenue"], cat["margin_pct"], s=sizes,
               color=ps.ACCENT, alpha=0.55, edgecolor="white", linewidth=1.5, zorder=3)
    ax.axhline(cat["gross_profit"].sum() / cat["net_revenue"].sum(),
               color=ps.MUTED, ls="--", lw=1.2)
    ax.text(cat["net_revenue"].max(), cat["gross_profit"].sum() / cat["net_revenue"].sum(),
            "  blended margin", va="bottom", ha="right", color=ps.MUTED, fontsize=10)

    top = cat.iloc[0]
    ps.titles(ax,
              f"{top['category']} is {top['revenue_share']:.0%} of revenue but only "
              f"{top['profit_share']:.0%} of profit - volume without margin",
              "Bubble area = share of total gross profit")
    ax.set_xlabel("Net revenue")
    ax.set_ylabel("Gross margin %")
    ax.set_ylim(0, cat["margin_pct"].max() * 1.35)
    ax.set_xlim(-cat["net_revenue"].max() * 0.06, cat["net_revenue"].max() * 1.18)
    ps.money_axis(ax, axis="x")
    ps.pct_axis(ax)
    ps.style_axes(ax, xgrid=True)
    ps.direct_labels(
        ax,
        [(f"{r['category']}  {ps.money(r['net_revenue'])} @ {r['margin_pct']:.0%}",
          r["net_revenue"], r["margin_pct"], ps.ACCENT) for _, r in cat.iterrows()],
        min_gap=0.085, x_range=(0.03, 0.62), fontsize=9.5,
    )
    return ps.save(fig, os.path.join(outdir, "07_category_revenue_vs_margin.png"))


# ---------------------------------------------------------------------------
# 8. Regional performance
# ---------------------------------------------------------------------------
def fig_regional(res: dict, outdir: str) -> str:
    reg = res["regions"].sort_values("net_revenue")
    fig, axes = plt.subplots(1, 2, figsize=(13, 5.8), gridspec_kw={"width_ratios": [1.35, 1]})

    ax = axes[0]
    bars = ax.barh(reg["region"], reg["net_revenue"], color=ps.ACCENT, height=0.66)
    ps.label_bars(ax, bars, fmt=ps.money, horizontal=True)
    ax.set_xlim(0, reg["net_revenue"].max() * 1.22)
    ax.set_title("Total net revenue", loc="left", fontsize=12)
    ps.money_axis(ax, axis="x")
    ps.style_axes(ax, xgrid=True, ygrid=False)

    ax = axes[1]
    reg2 = res["regions"].sort_values("revenue_per_customer")
    bars = ax.barh(reg2["region"], reg2["revenue_per_customer"], color=ps.ACCENT_2, height=0.66)
    ps.label_bars(ax, bars, fmt=lambda v: f"£{v:,.0f}", horizontal=True)
    ax.set_xlim(0, reg2["revenue_per_customer"].max() * 1.25)
    ax.set_title("Revenue per purchasing customer", loc="left", fontsize=12)
    ps.money_axis(ax, axis="x")
    ps.style_axes(ax, xgrid=True, ygrid=False)

    biggest = res["regions"].iloc[0]
    richest = res["regions"].sort_values("revenue_per_customer", ascending=False).iloc[0]
    fig.suptitle(f"{biggest['region']} is the biggest region ({biggest['revenue_share']:.0%} of revenue), "
                 f"but {richest['region']} customers are worth the most "
                 f"(£{richest['revenue_per_customer']:,.0f} each)",
                 x=0.005, ha="left", fontsize=14.5, fontweight="semibold", color=ps.INK)
    fig.tight_layout(rect=(0, 0, 1, 0.93))
    return ps.save(fig, os.path.join(outdir, "08_regional_performance.png"))


# ---------------------------------------------------------------------------
# 9. Channel mix over time
# ---------------------------------------------------------------------------
def fig_channel_mix(res: dict, outdir: str) -> str:
    mix = res["channel_mix"]
    ch = res["channels"].set_index("channel")
    cols = [c for c in ch.index if c in mix.columns]
    mix = mix[cols]

    fig, ax = plt.subplots(figsize=(11.5, 6))
    ax.stackplot(mix.index, [mix[c] for c in cols], labels=cols,
                 colors=ps.OKABE_ITO[: len(cols)], alpha=0.92, edgecolor="white", lw=0.4)
    # direct labels in the middle of each band, at the right-hand edge
    last = mix.iloc[-1]
    cum = 0.0
    for c in cols:
        v = last[c]
        ax.text(mix.index[-1] + pd.Timedelta(days=20), cum + v / 2, f"{c}  {v:.0%}",
                va="center", ha="left", fontsize=10, color=ps.INK,
                fontweight="semibold", clip_on=False)
        cum += v
    ax.set_xlim(mix.index.min(), mix.index.max() + pd.Timedelta(days=15))
    ax.set_ylim(0, 1)

    top = res["channels"].iloc[0]
    ps.titles(ax,
              f"{top['channel']} carries {top['revenue_share']:.0%} of revenue and the mix is stable - "
              "no channel is running away",
              f"Share of monthly net revenue by channel; right-hand labels are the final "
              f"month's share. AOV ranges from {ps.money(res['channels']['aov'].min())} to "
              f"{ps.money(res['channels']['aov'].max())}")
    ax.set_ylabel("Share of revenue")
    ps.pct_axis(ax)
    ps.style_axes(ax, ygrid=False)
    return ps.save(fig, os.path.join(outdir, "09_channel_mix.png"))


# ---------------------------------------------------------------------------
# 10. Cohort retention heatmap
# ---------------------------------------------------------------------------
def fig_cohort_heatmap(res: dict, outdir: str) -> str:
    co = res["cohorts"]
    matrix = co["matrix"].copy()
    matrix.index = [d.strftime("%Y-%m") for d in matrix.index]

    fig, ax = plt.subplots(figsize=(12, 9))
    sns.heatmap(matrix * 100, cmap=ps.SEQ_CMAP, annot=True, fmt=".0f", linewidths=0.5,
                linecolor="white", vmin=0, vmax=45, ax=ax, annot_kws={"fontsize": 7.5},
                cbar_kws={"label": "% of cohort still ordering"})
    ax.set_xlabel("Months since first purchase")
    ax.set_ylabel("Acquisition cohort")
    ps.titles(ax,
              f"Retention settles fast: {co['m1_retention']:.0%} come back in month 1 and "
              f"{co['m12_retention']:.0%} are still active a year later",
              f"Share of each cohort placing an order in month N (100% by definition in month 0). "
              f"Averaged over {co['n_full_cohorts']} cohorts with a full 12-month window")
    ax.tick_params(left=False, bottom=False)
    return ps.save(fig, os.path.join(outdir, "10_cohort_retention_heatmap.png"))


# ---------------------------------------------------------------------------
# 11. RFM scatter
# ---------------------------------------------------------------------------
def fig_rfm_scatter(customer_level: pd.DataFrame, res: dict, outdir: str) -> str:
    cl = customer_level
    prof = res["rfm"]
    order = prof["rfm_segment"].tolist()
    pal = {s: ps.OKABE_ITO[i % len(ps.OKABE_ITO)] for i, s in enumerate(order)}

    fig, ax = plt.subplots(figsize=(11.5, 6.8))
    ax.scatter(cl["recency_days"], cl["frequency"],
               s=np.clip(cl["monetary"] / 220, 6, 320),
               c=[pal[s] for s in cl["rfm_segment"]], alpha=0.45,
               edgecolor="white", linewidth=0.3)
    # One direct label per segment, anchored on its centroid but de-overlapped
    # by the shared helper (labels never sit on top of one another).
    cent = cl.groupby("rfm_segment", observed=True).agg(
        r=("recency_days", "median"), f=("frequency", "median"), n=("customer_id", "size"))
    ax.set_xlim(left=-40)
    ps.direct_labels(
        ax,
        [(f"{seg}  -  {int(row['n']):,} customers", row["r"], row["f"], pal[seg])
         for seg, row in cent.iterrows()],
        min_gap=0.088, x_range=(0.06, 0.72), fontsize=9.5,
    )

    champs = prof[prof["rfm_segment"] == "Champions"]
    head = (f"Champions are {champs['customer_share'].iloc[0]:.0%} of customers but "
            f"{champs['revenue_share'].iloc[0]:.0%} of revenue"
            if len(champs) else "RFM segments")
    ps.titles(ax, head,
              "Each dot is a customer: recency vs frequency, sized by lifetime spend. "
              "Left and high = valuable and active")
    ax.set_xlabel("Recency - days since last order (lower is better)")
    ax.set_ylabel("Frequency - orders placed")
    ax.set_yscale("log")
    ax.set_yticks([1, 2, 5, 10, 20, 50])
    ax.get_yaxis().set_major_formatter(plt.ScalarFormatter())
    ps.style_axes(ax, xgrid=True)
    return ps.save(fig, os.path.join(outdir, "11_rfm_scatter.png"))


# ---------------------------------------------------------------------------
# 12. RFM treemap
# ---------------------------------------------------------------------------
def fig_rfm_treemap(res: dict, outdir: str) -> str:
    prof = res["rfm"].sort_values("total_revenue", ascending=False).reset_index(drop=True)
    rects = ps.squarify(prof["total_revenue"].tolist(), 0, 0, 100, 62)

    fig, ax = plt.subplots(figsize=(11.5, 6.6))
    for i, (r, row) in enumerate(zip(rects, prof.itertuples())):
        color = ps.OKABE_ITO[i % len(ps.OKABE_ITO)]
        ax.add_patch(plt.Rectangle((r["x"], r["y"]), r["dx"], r["dy"],
                                   facecolor=color, edgecolor="white", lw=2.5, alpha=0.88))
        w, h = r["dx"], r["dy"]
        if w < 7 or h < 1.4:
            continue
        # Pick the richest label the rectangle can actually hold: font size is
        # capped by BOTH the width (characters) and the height (lines), so no
        # label ever spills outside its tile.
        if h >= 15 and w >= 22:
            lines = [row.rfm_segment,
                     f"{ps.money(row.total_revenue)}  ({row.revenue_share:.0%})",
                     f"{row.customers:,} customers"]
        elif h >= 9 and w >= 15:
            lines = [row.rfm_segment, f"{row.revenue_share:.0%}"]
        else:
            lines = [f"{row.rfm_segment}  {row.revenue_share:.0%}"]
        longest = max(len(t) for t in lines)
        fs_w = w / (0.085 * longest)                  # ~0.085 data units per pt of char
        fs_h = h / (0.30 * len(lines))                # ~0.30 data units per pt of line
        fs = float(np.clip(min(fs_w, fs_h), 6.0, 12.5))
        # white on dark tiles, ink on light ones (the yellow tile needs it)
        rgb = mcolors.to_rgb(color)
        lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
        ax.text(r["x"] + w / 2, r["y"] + h / 2, "\n".join(lines),
                ha="center", va="center", fontsize=fs,
                color="white" if lum < 0.62 else ps.INK,
                fontweight="semibold", linespacing=1.25, clip_on=True)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 62)
    ax.axis("off")

    top2 = prof.head(2)
    ps.titles(ax,
              f"{top2['rfm_segment'].iloc[0]} and {top2['rfm_segment'].iloc[1]} together account for "
              f"{top2['revenue_share'].sum():.0%} of all revenue",
              "Area = lifetime revenue contributed by each RFM segment")
    return ps.save(fig, os.path.join(outdir, "12_rfm_treemap.png"))


# ---------------------------------------------------------------------------
# 13. Correlation matrix
# ---------------------------------------------------------------------------
def fig_correlation(res: dict, outdir: str) -> str:
    corr = res["correlations"]
    labels = {"order_value": "Order value", "gross_profit": "Gross profit",
              "order_size": "Units", "n_lines": "Lines", "avg_discount_rate": "Discount rate",
              "shipping_cost": "Shipping cost", "basket_n_categories": "Categories in basket",
              "order_margin_pct": "Order margin %"}
    c = corr.rename(index=labels, columns=labels)
    mask = np.triu(np.ones_like(c, dtype=bool), k=1)

    fig, ax = plt.subplots(figsize=(9.5, 7.5))
    sns.heatmap(c, mask=mask, cmap=ps.DIV_CMAP, vmin=-1, vmax=1, annot=True, fmt=".2f",
                linewidths=0.6, linecolor="white", square=True, ax=ax,
                cbar_kws={"label": "Pearson r", "shrink": 0.75}, annot_kws={"fontsize": 9})
    r_profit = float(corr.loc["order_value", "gross_profit"])
    r_disc = float(corr.loc["order_value", "avg_discount_rate"])
    r_size = float(corr.loc["order_value", "order_size"])
    ps.titles(ax,
              f"Order value and gross profit move as one (r = {r_profit:.2f}), but discounting "
              f"is unrelated to basket value (r = {r_disc:+.2f})",
              f"Pearson correlation across order-level measures. Units explain surprisingly "
              f"little of order value (r = {r_size:.2f}) - price, not quantity, drives the basket")
    ax.tick_params(left=False, bottom=False)
    ax.grid(False)
    plt.setp(ax.get_xticklabels(), rotation=32, ha="right")
    return ps.save(fig, os.path.join(outdir, "13_correlation_matrix.png"))


# ---------------------------------------------------------------------------
# 14. Distributions
# ---------------------------------------------------------------------------
def fig_distributions(order_level: pd.DataFrame, customer_level: pd.DataFrame,
                      lines: pd.DataFrame, outdir: str) -> str:
    fig, axes = plt.subplots(2, 2, figsize=(13, 8.4))

    ax = axes[0, 0]
    v = order_level.loc[order_level["order_value"] > 0, "order_value"]
    ax.hist(v, bins=np.logspace(np.log10(max(v.min(), 1)), np.log10(v.max()), 60),
            color=ps.ACCENT, alpha=0.85)
    ax.set_xscale("log")
    ax.axvline(v.median(), color=ps.NEGATIVE, lw=2)
    ax.text(v.median(), ax.get_ylim()[1] * 0.92, f" median {ps.money(v.median())}",
            color=ps.NEGATIVE, fontsize=10)
    ax.set_title(f"Order value is log-normal: mean {ps.money(v.mean())} vs median "
                 f"{ps.money(v.median())}", loc="left", fontsize=12)
    ax.set_xlabel("Order value (log scale)")
    ps.style_axes(ax)

    ax = axes[0, 1]
    counts = order_level["n_lines"].value_counts().sort_index()
    bars = ax.bar(counts.index, counts.to_numpy(), color=ps.OKABE_ITO[2], width=0.66)
    ps.label_bars(ax, bars, fmt=lambda x: f"{x / len(order_level):.0%}", fontsize=9)
    ax.set_title(f"{counts.iloc[0] / counts.sum():.0%} of orders are a single line",
                 loc="left", fontsize=12)
    ax.set_xlabel("Lines per order")
    ax.set_ylim(0, counts.max() * 1.16)
    ps.style_axes(ax)

    ax = axes[1, 0]
    d = lines.loc[lines["discount_rate"] > 0, "discount_rate"]
    ax.hist(d, bins=40, color=ps.ACCENT_2, alpha=0.9)
    share_disc = (lines["discount_rate"] > 0).mean()
    ax.axvline(d.mean(), color=ps.INK, lw=1.8, ls="--")
    ax.text(d.mean(), ax.get_ylim()[1] * 0.9, f"  mean {d.mean():.0%}", fontsize=10)
    ax.set_title(f"{share_disc:.0%} of lines are discounted, averaging {d.mean():.0%} off",
                 loc="left", fontsize=12)
    ax.set_xlabel("Discount rate on discounted lines")
    ps.pct_axis(ax, axis="x")
    ps.style_axes(ax)

    ax = axes[1, 1]
    c = customer_level.loc[customer_level["clv_estimate"] > 0, "clv_estimate"]
    ax.hist(c, bins=np.logspace(np.log10(max(c.min(), 1)), np.log10(c.quantile(0.999)), 55),
            color=ps.OKABE_ITO[3], alpha=0.88)
    ax.set_xscale("log")
    top_decile = c.nlargest(max(int(len(c) * 0.1), 1)).sum() / c.sum()
    ax.axvline(c.median(), color=ps.INK, lw=2)
    ax.text(c.median(), ax.get_ylim()[1] * 0.92, f" median {ps.money(c.median())}", fontsize=10)
    ax.set_title(f"CLV is heavily skewed: the top decile holds {top_decile:.0%} of it",
                 loc="left", fontsize=12)
    ax.set_xlabel("Estimated CLV (log scale)")
    ps.style_axes(ax)

    fig.suptitle("Every core distribution is right-skewed - report medians, not just means",
                 x=0.005, ha="left", fontsize=15, fontweight="semibold", color=ps.INK)
    fig.tight_layout(rect=(0, 0, 1, 0.945))
    return ps.save(fig, os.path.join(outdir, "14_distributions.png"))


# ---------------------------------------------------------------------------
def make_all_figures(lines: pd.DataFrame, order_level: pd.DataFrame,
                     customer_level: pd.DataFrame, res: dict,
                     outdir: str | None = None, verbose: bool = True) -> list[str]:
    ps.apply_style()
    outdir = outdir or config.FIGURES_DIR
    os.makedirs(outdir, exist_ok=True)

    paths = [
        fig_revenue_trend(res, outdir),
        fig_mom_growth(res, outdir),
        fig_seasonality_heatmap(res, outdir),
        fig_day_of_week(res, outdir),
        fig_pareto(res, outdir),
        fig_category_margin_box(lines, res, outdir),
        fig_category_revenue_vs_margin(res, outdir),
        fig_regional(res, outdir),
        fig_channel_mix(res, outdir),
        fig_cohort_heatmap(res, outdir),
        fig_rfm_scatter(customer_level, res, outdir),
        fig_rfm_treemap(res, outdir),
        fig_correlation(res, outdir),
        fig_distributions(order_level, customer_level, lines, outdir),
    ]
    if verbose:
        for p in paths:
            print(f"[viz] {os.path.basename(p):<38} {os.path.getsize(p) / 1024:>7,.0f} KB")
    return paths


if __name__ == "__main__":
    from cleaning import run_cleaning
    from features import build_all
    from analysis import run_all
    o, c, p = run_cleaning(write=False, verbose=False)[:3]
    lines, order_level, customer_level = build_all(o, c, p, write=False, verbose=False)
    res = run_all(lines, order_level, customer_level, verbose=False)
    make_all_figures(lines, order_level, customer_level, res)
