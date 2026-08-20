"""
Synthetic e-commerce dataset generator
======================================

Creates three raw CSV files in ``data/raw`` that imitate an export from a
mid-sized online retailer's order database:

    orders.csv     ~50,000 order *lines* (an order can hold several lines)
    customers.csv  ~8,000 customers
    products.csv   ~400 products

The data is **entirely synthetic** - nothing here comes from a real company -
but it is generated from a behavioural model rather than from uniform noise, so
the analytical results are meaningful:

* a 3-year window (2023-01-01 .. 2025-12-31) with an underlying growth trend,
* a Christmas / Black-Friday seasonal peak and a summer dip,
* weekday-vs-weekend purchasing differences,
* per-customer retention decay, which produces realistic cohort curves,
* Pareto-shaped product popularity (a few SKUs drive most of the revenue),
* category-dependent gross margins,
* channel-dependent basket sizes,
* a mild statistical dependence between customer segment and region.

On top of that the generator deliberately injects the kind of mess a real
extract contains, so that ``src/cleaning.py`` has something to do:

    * ~2%   missing values, spread over several columns
    * ~300  fully duplicated order rows (a classic double-ingest bug)
    * ~0.8% negative quantities (returns booked against the original order)
    * inconsistent city capitalisation and stray whitespace
    * dates written in TWO different string formats (ISO and D/M/Y)
    * a handful of extreme unit prices (fat-finger / bundle SKUs)
    * numbers stored as text ("$1,299.00", "15%")

Everything is driven by a single fixed seed, so the output is byte-for-byte
reproducible:

    python data/generate_dataset.py
"""

from __future__ import annotations

import os
from datetime import date, timedelta

import numpy as np
import pandas as pd

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
SEED = 42
RNG = np.random.default_rng(SEED)

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, "raw")

N_CUSTOMERS = 8_000
N_PRODUCTS = 400
TARGET_ORDER_LINES = 50_000

ORDER_START = date(2023, 1, 1)
ORDER_END = date(2025, 12, 31)
SIGNUP_START = date(2022, 1, 1)          # a year of "legacy" customers
SIGNUP_END = date(2025, 12, 31)

N_DUPLICATE_ROWS = 300
MISSING_RATE = 0.02
NEGATIVE_QTY_RATE = 0.008
PRICE_OUTLIER_RATE = 0.0015
TEXT_NUMBER_RATE = 0.015
ALT_DATE_FORMAT_RATE = 0.30

# --------------------------------------------------------------------------
# Reference data
# --------------------------------------------------------------------------
REGIONS = ["North", "South", "East", "West", "Central"]
REGION_WEIGHTS = np.array([0.24, 0.21, 0.19, 0.23, 0.13])

CITIES = {
    "North": ["Manchester", "Leeds", "Newcastle", "York", "Sheffield"],
    "South": ["Brighton", "Southampton", "Portsmouth", "Reading", "Oxford"],
    "East":  ["Norwich", "Cambridge", "Ipswich", "Colchester", "Peterborough"],
    "West":  ["Bristol", "Cardiff", "Exeter", "Bath", "Plymouth"],
    "Central": ["Birmingham", "Nottingham", "Leicester", "Coventry", "Derby"],
}

SEGMENTS = ["Consumer", "Home Office", "Small Business", "Corporate"]
# Segment mix differs slightly by region -> the chi-square test has real signal.
SEGMENT_MIX_BY_REGION = {
    "North":   [0.56, 0.19, 0.16, 0.09],
    "South":   [0.50, 0.20, 0.18, 0.12],
    "East":    [0.58, 0.18, 0.15, 0.09],
    "West":    [0.53, 0.20, 0.17, 0.10],
    "Central": [0.44, 0.20, 0.21, 0.15],   # more business buyers
}
SEGMENT_ORDER_RATE = {           # relative purchase frequency
    "Consumer": 1.00,
    "Home Office": 1.25,
    "Small Business": 1.70,
    "Corporate": 2.30,
}
SEGMENT_BASKET = {               # relative basket value
    "Consumer": 1.00,
    "Home Office": 1.15,
    "Small Business": 1.45,
    "Corporate": 1.95,
}

CHANNELS = ["Web", "Mobile App", "Marketplace", "Retail Store"]
CHANNEL_WEIGHTS = np.array([0.38, 0.31, 0.19, 0.12])
# Mobile baskets are deliberately smaller than Web -> the two-sample t-test on
# AOV between Web and Mobile App has a real effect to detect.
CHANNEL_BASKET_FACTOR = {"Web": 1.00, "Mobile App": 0.82, "Marketplace": 0.93, "Retail Store": 1.10}
# Lines per order also depend on the channel: mobile shoppers buy one thing in a
# hurry, in-store shoppers fill a basket.  This is what makes Web AOV materially
# higher than Mobile App AOV (the effect the t-test in analysis.py looks for).
CHANNEL_LINES_P = {
    "Web":          [0.42, 0.28, 0.16, 0.09, 0.05],   # mean 2.07 lines
    "Mobile App":   [0.68, 0.21, 0.07, 0.03, 0.01],   # mean 1.48 lines
    "Marketplace":  [0.55, 0.26, 0.12, 0.05, 0.02],   # mean 1.73 lines
    "Retail Store": [0.34, 0.28, 0.20, 0.12, 0.06],   # mean 2.28 lines
}
MEAN_LINES_PER_ORDER = 1.86
CHANNEL_DISCOUNT_BIAS = {"Web": 0.00, "Mobile App": 0.02, "Marketplace": 0.05, "Retail Store": -0.01}

PAYMENT_METHODS = ["Credit Card", "Debit Card", "PayPal", "Bank Transfer", "Gift Card"]
PAYMENT_WEIGHTS = np.array([0.40, 0.24, 0.22, 0.09, 0.05])

# category -> (subcategories, mean list price, gross-margin mean, popularity weight)
CATEGORIES = {
    "Electronics":       (["Laptops", "Audio", "Phones", "Wearables", "Cameras"], 420.0, 0.22, 1.00),
    "Home & Kitchen":    (["Cookware", "Small Appliances", "Storage", "Bedding"], 85.0, 0.38, 1.15),
    "Apparel":           (["Menswear", "Womenswear", "Footwear", "Accessories"], 55.0, 0.52, 1.30),
    "Sports & Outdoors": (["Fitness", "Camping", "Cycling", "Team Sports"], 110.0, 0.35, 0.80),
    "Beauty":            (["Skincare", "Haircare", "Fragrance", "Cosmetics"], 32.0, 0.58, 0.95),
    "Office Supplies":   (["Paper", "Writing", "Furniture", "Printers"], 45.0, 0.31, 0.70),
    "Toys & Games":      (["Board Games", "Outdoor Toys", "Puzzles", "Figures"], 38.0, 0.44, 0.60),
    "Grocery":           (["Coffee & Tea", "Snacks", "Household", "Pantry"], 18.0, 0.26, 0.85),
}

SUPPLIERS = [f"SUP-{i:03d}" for i in range(1, 31)]

PRODUCT_ADJECTIVES = ["Classic", "Pro", "Ultra", "Eco", "Compact", "Premium", "Everyday",
                      "Deluxe", "Essential", "Signature", "Urban", "Nordic"]
PRODUCT_NOUNS = ["Series", "Edition", "Collection", "Line", "Model", "Kit", "Set", "Pack"]


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _format_date(d: date, alt: bool) -> str:
    """Two on-purpose inconsistent date formats: ISO and D/M/Y."""
    return d.strftime("%d/%m/%Y") if alt else d.strftime("%Y-%m-%d")


def _messy_city(city: str) -> str:
    """Randomly mangle capitalisation / whitespace the way free-text entry does."""
    roll = RNG.random()
    if roll < 0.55:
        return city
    if roll < 0.72:
        return city.lower()
    if roll < 0.84:
        return city.upper()
    if roll < 0.93:
        return f"  {city} "
    return city.replace(" ", "  ").lower()


def _inject_missing(series: pd.Series, rate: float) -> pd.Series:
    mask = RNG.random(len(series)) < rate
    out = series.astype(object).copy()
    out[mask] = np.nan
    return out


# --------------------------------------------------------------------------
# 1. Products
# --------------------------------------------------------------------------
def build_products() -> pd.DataFrame:
    cat_names = list(CATEGORIES)
    cat_pop = np.array([CATEGORIES[c][3] for c in cat_names], dtype=float)
    cat_pop /= cat_pop.sum()
    chosen = RNG.choice(cat_names, size=N_PRODUCTS, p=cat_pop)

    rows = []
    for i, cat in enumerate(chosen, start=1):
        subcats, mean_price, margin_mu, _ = CATEGORIES[cat]
        subcat = RNG.choice(subcats)
        # lognormal price spread around the category mean
        list_price = float(np.round(mean_price * RNG.lognormal(mean=-0.10, sigma=0.45), 2))
        list_price = max(list_price, 3.0)
        margin = float(np.clip(RNG.normal(margin_mu, 0.06), 0.05, 0.75))
        cost = float(np.round(list_price * (1 - margin), 2))
        name = f"{RNG.choice(PRODUCT_ADJECTIVES)} {subcat[:-1] if subcat.endswith('s') else subcat} {RNG.choice(PRODUCT_NOUNS)}"
        rows.append(
            {
                "product_id": f"P{i:04d}",
                "name": name,
                "category": cat,
                "subcategory": subcat,
                "cost": cost,
                "list_price": list_price,
                "supplier": RNG.choice(SUPPLIERS),
            }
        )
    df = pd.DataFrame(rows)

    # messiness: missing subcategory / supplier, and a couple of category typos
    df["supplier"] = _inject_missing(df["supplier"], MISSING_RATE)
    df["subcategory"] = _inject_missing(df["subcategory"], MISSING_RATE / 2)
    typo_idx = RNG.choice(df.index, size=8, replace=False)
    df.loc[typo_idx, "category"] = df.loc[typo_idx, "category"].str.upper()
    typo_idx2 = RNG.choice(df.index.difference(typo_idx), size=6, replace=False)
    df.loc[typo_idx2, "category"] = " " + df.loc[typo_idx2, "category"] + " "
    return df


# --------------------------------------------------------------------------
# 2. Customers
# --------------------------------------------------------------------------
def build_customers() -> pd.DataFrame:
    span = (SIGNUP_END - SIGNUP_START).days
    # signups accelerate over time (a growing business)
    u = RNG.random(N_CUSTOMERS) ** 0.78
    signup_offsets = np.round(u * span).astype(int)
    signup_dates = [SIGNUP_START + timedelta(days=int(o)) for o in signup_offsets]

    regions = RNG.choice(REGIONS, size=N_CUSTOMERS, p=REGION_WEIGHTS)
    segments, cities = [], []
    for r in regions:
        segments.append(RNG.choice(SEGMENTS, p=SEGMENT_MIX_BY_REGION[r]))
        cities.append(_messy_city(str(RNG.choice(CITIES[r]))))

    ages = np.clip(RNG.normal(41, 13, N_CUSTOMERS), 18, 84).round().astype(int)
    genders = RNG.choice(["F", "M", "Other"], size=N_CUSTOMERS, p=[0.49, 0.48, 0.03])

    alt = RNG.random(N_CUSTOMERS) < ALT_DATE_FORMAT_RATE
    df = pd.DataFrame(
        {
            "customer_id": [f"C{i:05d}" for i in range(1, N_CUSTOMERS + 1)],
            "signup_date": [_format_date(d, a) for d, a in zip(signup_dates, alt)],
            "age": ages,
            "gender": genders,
            "city": cities,
            "region": regions,
            "segment": segments,
        }
    )

    # messiness: missing demographics, a few impossible ages
    df["age"] = _inject_missing(df["age"], MISSING_RATE)
    df["gender"] = _inject_missing(df["gender"], MISSING_RATE)
    df["city"] = _inject_missing(df["city"], MISSING_RATE / 2)
    bad_age_idx = RNG.choice(df.index, size=12, replace=False)
    df.loc[bad_age_idx, "age"] = RNG.choice([0, 5, 130, 999], size=12)
    return df, signup_dates


# --------------------------------------------------------------------------
# 3. Orders
# --------------------------------------------------------------------------
def _month_index(d: date) -> int:
    return (d.year - ORDER_START.year) * 12 + (d.month - ORDER_START.month)


def _seasonal_factor(month_of_year: int) -> float:
    """Retail seasonality: November/December peak, summer trough."""
    table = {1: 0.82, 2: 0.80, 3: 0.92, 4: 0.95, 5: 0.98, 6: 0.93,
             7: 0.88, 8: 0.87, 9: 1.00, 10: 1.08, 11: 1.42, 12: 1.55}
    return table[month_of_year]


def _dow_factor(weekday: int) -> float:
    """Mon=0 .. Sun=6.  Mid-week dip, weekend browse-and-buy peak."""
    return [1.02, 0.97, 0.94, 0.96, 1.05, 1.24, 1.18][weekday]


def build_orders(customers: pd.DataFrame, signup_dates, products: pd.DataFrame) -> pd.DataFrame:
    n_months = _month_index(ORDER_END) + 1                      # 36
    months = [ORDER_START + pd.DateOffset(months=m) for m in range(n_months)]
    months = [m.date() for m in months]

    # ---- per-customer latent purchase rate -------------------------------
    seg_rate = customers["segment"].map(SEGMENT_ORDER_RATE).to_numpy(dtype=float)
    base_rate = RNG.lognormal(mean=-1.05, sigma=0.62, size=N_CUSTOMERS) * seg_rate
    # each customer has their own retention half-life (months)
    half_life = RNG.gamma(shape=2.4, scale=4.2, size=N_CUSTOMERS) + 1.5

    signup_month = np.array(
        [max(_month_index(d), 0) if d >= ORDER_START else 0 for d in signup_dates]
    )
    signup_before_window = np.array([d < ORDER_START for d in signup_dates])
    # customers who joined before the window are already partway through their life
    head_start = np.where(signup_before_window,
                          np.array([(ORDER_START - d).days / 30.4 for d in signup_dates]), 0.0)

    trend = 1.0 + 0.014 * np.arange(n_months)                    # ~1.4% MoM drift
    season = np.array([_seasonal_factor(m.month) for m in months])
    month_mult = trend * season

    eligible_from = np.array(
        [_month_index(d) if d >= ORDER_START else 0 for d in signup_dates]
    )

    m_grid = np.arange(n_months)[None, :]                        # (1, 36)
    tenure = (m_grid - eligible_from[:, None]) + head_start[:, None]
    retention = np.exp(-np.maximum(tenure, 0) / half_life[:, None])
    retention = 0.10 + 0.90 * retention                          # floor: loyal core
    lam = base_rate[:, None] * retention * month_mult[None, :]
    lam = np.where(m_grid >= eligible_from[:, None], lam, 0.0)

    # Calibrate the intensity so that the whole 36-month window yields roughly
    # TARGET_ORDER_LINES lines.  Without this the ledger would have to be
    # truncated, which would silently chop the most recent (and largest) months.
    target_orders = (TARGET_ORDER_LINES - N_DUPLICATE_ROWS) / MEAN_LINES_PER_ORDER
    lam = lam * (target_orders / lam.sum())

    counts = RNG.poisson(lam)                                    # (8000, 36) orders

    cust_idx, month_idx = np.nonzero(counts)
    reps = counts[cust_idx, month_idx]
    cust_idx = np.repeat(cust_idx, reps)
    month_idx = np.repeat(month_idx, reps)
    n_orders = len(cust_idx)

    # ---- pick a day inside the month, weighted by day-of-week ------------
    order_dates = np.empty(n_orders, dtype=object)
    for m in range(n_months):
        sel = np.nonzero(month_idx == m)[0]
        if sel.size == 0:
            continue
        start = months[m]
        days_in_month = (pd.Timestamp(start) + pd.offsets.MonthEnd(0)).day
        day_opts = np.arange(days_in_month)
        w = np.array([_dow_factor((start + timedelta(days=int(d))).weekday()) for d in day_opts])
        w = w / w.sum()
        picks = RNG.choice(day_opts, size=sel.size, p=w)
        for i, p in zip(sel, picks):
            order_dates[i] = start + timedelta(days=int(p))

    # keep the natural chronological order of the ledger
    sort_ix = np.argsort([d.toordinal() for d in order_dates], kind="stable")
    cust_idx, order_dates = cust_idx[sort_ix], order_dates[sort_ix]

    # ---- order-level attributes ------------------------------------------
    channel = RNG.choice(CHANNELS, size=n_orders, p=CHANNEL_WEIGHTS)
    payment = RNG.choice(PAYMENT_METHODS, size=n_orders, p=PAYMENT_WEIGHTS)

    # ---- lines per order (channel dependent) ------------------------------
    lines_per_order = np.empty(n_orders, dtype=int)
    for ch, probs in CHANNEL_LINES_P.items():
        sel = np.nonzero(channel == ch)[0]
        lines_per_order[sel] = RNG.choice([1, 2, 3, 4, 5], size=sel.size, p=probs)

    # If we overshot the target, drop whole orders at random (uniformly across
    # the three years) rather than truncating the tail of the calendar.
    total = int(lines_per_order.sum())
    budget = TARGET_ORDER_LINES - N_DUPLICATE_ROWS
    if total > budget:
        perm = RNG.permutation(n_orders)
        cum = np.cumsum(lines_per_order[perm])
        k = int(np.searchsorted(cum, budget))
        keep_idx = np.sort(perm[:k])
        cust_idx = cust_idx[keep_idx]
        order_dates = order_dates[keep_idx]
        lines_per_order = lines_per_order[keep_idx]
        channel = channel[keep_idx]
        payment = payment[keep_idx]
        n_orders = len(keep_idx)

    # ---- Pareto-shaped product popularity --------------------------------
    # A *shifted* Zipf (1/(rank+20)^1.5) rather than a raw 1/rank: it still gives
    # a long tail of dead SKUs, but stops a single hero product from swallowing
    # a quarter of the catalogue's sales, which no real range does.
    # Popularity is also mildly price-elastic (cheap things sell more units), so
    # unit concentration and revenue concentration are not the same curve.
    pop = 1.0 / np.power(np.arange(1, N_PRODUCTS + 1) + 20, 1.5)
    pop = pop[RNG.permutation(N_PRODUCTS)]
    cat_boost = products["category"].str.strip().str.title().map(
        {c: CATEGORIES[c][3] for c in CATEGORIES}
    ).fillna(1.0).to_numpy()
    price_elasticity = np.power(
        products["list_price"].to_numpy() / products["list_price"].median(), -0.35)
    pop = pop * cat_boost * price_elasticity
    pop /= pop.sum()

    total_lines = int(lines_per_order.sum())
    prod_pick = RNG.choice(N_PRODUCTS, size=total_lines, p=pop)

    order_ids = np.array([f"ORD-{i + 100000}" for i in range(n_orders)])
    line_order_ids = np.repeat(order_ids, lines_per_order)
    line_cust = np.repeat(customers["customer_id"].to_numpy()[cust_idx], lines_per_order)
    line_dates = np.repeat(order_dates, lines_per_order)

    # order-level attributes, broadcast to lines
    line_channel = np.repeat(channel, lines_per_order)
    line_payment = np.repeat(payment, lines_per_order)
    line_region = np.repeat(customers["region"].to_numpy()[cust_idx], lines_per_order)
    line_segment = np.repeat(customers["segment"].to_numpy()[cust_idx], lines_per_order)

    # ---- quantity / price / discount / shipping --------------------------
    basket_factor = (pd.Series(line_segment).map(SEGMENT_BASKET).to_numpy()
                     * pd.Series(line_channel).map(CHANNEL_BASKET_FACTOR).to_numpy())

    qty = 1 + RNG.poisson(np.clip(0.55 * basket_factor, 0.05, None), size=total_lines)
    qty = np.clip(qty, 1, 12)

    list_price = products["list_price"].to_numpy()[prod_pick]
    unit_price = np.round(list_price * RNG.normal(1.0, 0.05, total_lines), 2)
    unit_price = np.clip(unit_price, 1.0, None)

    disc_bias = pd.Series(line_channel).map(CHANNEL_DISCOUNT_BIAS).to_numpy()
    month_of_year = np.array([d.month for d in line_dates])
    promo = np.where(np.isin(month_of_year, [11, 12]), 0.06, 0.0)   # peak-season promos
    has_discount = RNG.random(total_lines) < (0.42 + disc_bias + promo)
    discount = np.where(
        has_discount,
        np.round(np.clip(RNG.beta(2.0, 6.0, total_lines) * 0.55 + disc_bias + promo, 0.0, 0.60), 3),
        0.0,
    )

    region_ship = {"North": 1.0, "South": 0.95, "East": 1.08, "West": 1.12, "Central": 0.88}
    ship_base = pd.Series(line_region).map(region_ship).to_numpy()
    shipping = np.round(np.where(line_channel == "Retail Store", 0.0,
                                 ship_base * RNG.gamma(2.4, 1.9, total_lines)), 2)

    alt = RNG.random(total_lines) < ALT_DATE_FORMAT_RATE
    orders = pd.DataFrame(
        {
            "order_id": line_order_ids,
            "customer_id": line_cust,
            "order_date": [_format_date(d, a) for d, a in zip(line_dates, alt)],
            "product_id": products["product_id"].to_numpy()[prod_pick],
            "quantity": qty,
            "unit_price": unit_price,
            "discount": discount,
            "shipping_cost": shipping,
            "payment_method": line_payment,
            "channel": line_channel,
            "region": line_region,
        }
    )

    # ======================================================================
    # Deliberate messiness
    # ======================================================================
    n = len(orders)

    # (a) returns booked as negative quantity
    ret_idx = RNG.choice(n, size=int(n * NEGATIVE_QTY_RATE), replace=False)
    orders.loc[ret_idx, "quantity"] = -orders.loc[ret_idx, "quantity"].abs()

    # (b) fat-finger / bundle price outliers
    out_idx = RNG.choice(n, size=int(n * PRICE_OUTLIER_RATE), replace=False)
    orders.loc[out_idx, "unit_price"] = (
        orders.loc[out_idx, "unit_price"] * RNG.uniform(18, 45, len(out_idx))
    ).round(2)

    # (c) numbers stored as text
    orders["unit_price"] = orders["unit_price"].astype(object)
    txt_idx = RNG.choice(n, size=int(n * TEXT_NUMBER_RATE), replace=False)
    orders.loc[txt_idx, "unit_price"] = [
        f"${v:,.2f}" for v in pd.to_numeric(orders.loc[txt_idx, "unit_price"])
    ]
    orders["discount"] = orders["discount"].astype(object)
    pct_idx = RNG.choice(n, size=int(n * TEXT_NUMBER_RATE), replace=False)
    orders.loc[pct_idx, "discount"] = [
        f"{float(v) * 100:.1f}%" for v in orders.loc[pct_idx, "discount"]
    ]

    # (d) missing values (~2% on a handful of columns)
    for col, rate in [
        ("discount", MISSING_RATE),
        ("shipping_cost", MISSING_RATE),
        ("payment_method", MISSING_RATE),
        ("region", MISSING_RATE / 2),
        ("quantity", MISSING_RATE / 4),
    ]:
        orders[col] = _inject_missing(orders[col], rate)

    # (e) ~300 duplicated rows (double ingest)
    dup_idx = RNG.choice(n, size=N_DUPLICATE_ROWS, replace=False)
    orders = pd.concat([orders, orders.iloc[dup_idx]], ignore_index=True)

    # (f) shuffle so duplicates are not all at the bottom
    orders = orders.sample(frac=1.0, random_state=SEED).reset_index(drop=True)
    return orders


# --------------------------------------------------------------------------
def main() -> None:
    os.makedirs(RAW_DIR, exist_ok=True)

    products = build_products()
    customers, signup_dates = build_customers()
    orders = build_orders(customers, signup_dates, products)

    products.to_csv(os.path.join(RAW_DIR, "products.csv"), index=False)
    customers.to_csv(os.path.join(RAW_DIR, "customers.csv"), index=False)
    orders.to_csv(os.path.join(RAW_DIR, "orders.csv"), index=False)

    print("Wrote raw CSVs to", RAW_DIR)
    print(f"  products.csv  : {len(products):>7,} rows")
    print(f"  customers.csv : {len(customers):>7,} rows")
    print(f"  orders.csv    : {len(orders):>7,} rows "
          f"({orders['order_id'].nunique():,} distinct orders)")
    print(f"  date range    : {ORDER_START} .. {ORDER_END}")
    print(f"  duplicates    : {int(orders.duplicated().sum()):,}")
    print(f"  missing cells : {int(orders.isna().sum().sum()):,}")


if __name__ == "__main__":
    main()
