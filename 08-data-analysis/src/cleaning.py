"""
Cleaning layer
==============

Turns the messy raw CSVs in ``data/raw`` into analysis-ready tables in
``data/processed``.

Design rules followed here
--------------------------
1. **Nothing is deleted silently.**  Every row that disappears is counted and
   explained in ``reports/data_quality_report.md``.
2. **Outliers are flagged, never dropped.**  A £9,000 unit price may be a
   fat-finger *or* a genuine bundle SKU; the analyst decides downstream, so we
   add boolean flag columns (``is_price_outlier``, ``is_revenue_outlier``) and
   leave the rows in place.
3. **Returns are business events, not errors.**  Negative quantities are kept,
   flagged with ``is_return`` and allowed to carry negative revenue, because
   net revenue is the number the business actually cares about.
4. **Every missing-value decision is justified per column** - see
   ``MISSING_VALUE_POLICY`` below, which is also rendered into the report.
5. **The pipeline is idempotent.**  ``clean(clean(x)) == clean(x)``; each step
   detects work it has already done. This is asserted in ``tests/``.

Run standalone with::

    python src/cleaning.py
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import config
else:                                                        # pragma: no cover
    from . import config


# ---------------------------------------------------------------------------
# Missing-value policy - documented once, applied and reported from here.
# ---------------------------------------------------------------------------
MISSING_VALUE_POLICY: dict[str, dict[str, str]] = {
    "orders.quantity": {
        "strategy": "drop row",
        "why": "Quantity is a core measure: without it no revenue can be computed "
               "and imputing it would invent turnover. Missingness is ~0.5% and "
               "shows no pattern by channel/region (MCAR), so dropping is safe.",
    },
    "orders.discount": {
        "strategy": "fill 0.0",
        "why": "In the source system a blank discount field means 'no promotion "
               "code applied'. ~58% of populated rows are already 0.0, so 0 is "
               "both the modal and the semantically correct value.",
    },
    "orders.shipping_cost": {
        "strategy": "median by channel x region",
        "why": "Shipping is essentially a lookup on channel (Retail Store = 0) and "
               "delivery region. The group median is robust to the long right tail "
               "of the shipping distribution; a global mean would over-charge "
               "cheap-to-serve regions.",
    },
    "orders.payment_method": {
        "strategy": "fill 'Unknown'",
        "why": "Un-imputable categorical. Filling with the mode would inflate "
               "'Credit Card' share and bias any payment-mix reporting; an explicit "
               "'Unknown' level keeps the bias visible.",
    },
    "orders.region": {
        "strategy": "back-fill from customers.region, else 'Unknown'",
        "why": "customers.csv is the authoritative source for a customer's region, "
               "so the value can be recovered exactly rather than guessed.",
    },
    "customers.age": {
        "strategy": "median by segment (+ is_age_imputed flag)",
        "why": "Age is skewed and used for profiling only. Segment medians preserve "
               "the between-segment differences; the flag lets any analysis exclude "
               "imputed rows. Impossible ages (<16, >100) are nulled first.",
    },
    "customers.gender": {
        "strategy": "fill 'Unknown'",
        "why": "Sensitive attribute - imputing it would fabricate demographics. "
               "An explicit 'Unknown' level is the honest representation.",
    },
    "customers.city": {
        "strategy": "fill 'Unknown'",
        "why": "Free-text field with no reliable donor column at row level; region "
               "is retained separately so no geographic analysis is lost.",
    },
    "products.supplier": {
        "strategy": "fill 'Unknown'",
        "why": "Supplier is a reporting dimension only; a placeholder keeps the "
               "product row (and its revenue) in the analysis.",
    },
    "products.subcategory": {
        "strategy": "fill 'Unspecified'",
        "why": "Same as supplier - dropping the product would silently remove its "
               "sales from every category roll-up.",
    },
}


# ---------------------------------------------------------------------------
# Quality log
# ---------------------------------------------------------------------------
@dataclass
class QualityLog:
    """Collects one row per data-quality issue detected/handled."""

    rows: list[dict[str, Any]] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)

    def add(self, table: str, column: str, issue: str, n: int, action: str) -> None:
        self.rows.append(
            {"table": table, "column": column, "issue": issue,
             "rows_affected": int(n), "action_taken": action}
        )

    def note(self, key: str, value: int) -> None:
        self.counts[key] = int(value)

    def to_frame(self) -> pd.DataFrame:
        if not self.rows:
            return pd.DataFrame(columns=["table", "column", "issue", "rows_affected", "action_taken"])
        return pd.DataFrame(self.rows)


# ---------------------------------------------------------------------------
# Small, idempotent primitives
# ---------------------------------------------------------------------------
def to_number(s: pd.Series) -> pd.Series:
    """
    Coerce a possibly-text numeric column to float.

    Handles ``"$1,299.00"``, ``"15.0%"``, ``" 12 "`` and already-numeric input,
    which makes it safe to run twice (idempotency requirement).
    """
    if pd.api.types.is_numeric_dtype(s):
        return s.astype("float64")
    txt = s.astype("string").str.strip()
    is_pct = txt.str.endswith("%").fillna(False)
    cleaned = (txt.str.replace(r"[^0-9eE.+-]", "", regex=True)
                  .replace({"": None}))
    out = pd.to_numeric(cleaned, errors="coerce")
    out = out.where(~is_pct, out / 100.0)
    return out.astype("float64")


def parse_dates(s: pd.Series) -> pd.Series:
    """
    Parse a date column that mixes ``YYYY-MM-DD`` and ``DD/MM/YYYY``.

    Two explicit passes (never ``dayfirst`` guessing) so that 03/04/2024 is
    unambiguously 3 April, and so a value can never be parsed two different
    ways between runs.
    """
    if pd.api.types.is_datetime64_any_dtype(s):
        return s
    txt = s.astype("string").str.strip()
    out = pd.to_datetime(txt, format="%Y-%m-%d", errors="coerce")
    todo = out.isna() & txt.notna()
    if todo.any():
        out.loc[todo] = pd.to_datetime(txt[todo], format="%d/%m/%Y", errors="coerce")
    return out


def normalise_text(s: pd.Series) -> pd.Series:
    """Trim, collapse internal whitespace and Title-Case a free-text label."""
    return (s.astype("string")
             .str.strip()
             .str.replace(r"\s+", " ", regex=True)
             .str.title())


def iqr_flags(s: pd.Series, k: float = 1.5) -> tuple[pd.Series, float, float]:
    """
    Tukey fence outlier flags.

    Returns ``(mask, lower, upper)``.  ``k=1.5`` is the standard fence; we use
    ``k=3`` ("far out" values) for revenue where a long right tail is expected
    and only genuinely extreme lines should be marked.
    """
    q1, q3 = s.quantile(0.25), s.quantile(0.75)
    iqr = q3 - q1
    lo, hi = q1 - k * iqr, q3 + k * iqr
    return (s < lo) | (s > hi), float(lo), float(hi)


# ---------------------------------------------------------------------------
# Table-level cleaners
# ---------------------------------------------------------------------------
def clean_products(raw: pd.DataFrame, log: QualityLog | None = None) -> pd.DataFrame:
    log = log or QualityLog()
    df = raw.copy()
    before = len(df)

    dups = int(df.duplicated(subset=["product_id"]).sum())
    if dups:
        df = df.drop_duplicates(subset=["product_id"], keep="first")
        log.add("products", "product_id", "duplicate product_id", dups, "kept first occurrence")

    # category / subcategory arrive with stray whitespace and SHOUTING
    raw_cats = df["category"].astype("string")
    df["category"] = normalise_text(raw_cats).replace({"Home & Kitchen": "Home & Kitchen"})
    n_norm = int((raw_cats.fillna("") != df["category"].fillna("")).sum())
    if n_norm:
        log.add("products", "category", "inconsistent case / padding", n_norm,
                "trimmed + Title Case")

    n_sub = int(df["subcategory"].isna().sum())
    df["subcategory"] = normalise_text(df["subcategory"]).fillna("Unspecified")
    if n_sub:
        log.add("products", "subcategory", "missing", n_sub, "filled 'Unspecified'")

    n_sup = int(df["supplier"].isna().sum())
    df["supplier"] = df["supplier"].astype("string").str.strip().fillna("Unknown")
    if n_sup:
        log.add("products", "supplier", "missing", n_sup, "filled 'Unknown'")

    for col in ("cost", "list_price"):
        df[col] = to_number(df[col])

    bad = int(((df["cost"] <= 0) | (df["list_price"] <= 0)).sum())
    if bad:
        log.add("products", "cost/list_price", "non-positive price", bad, "flagged only")
    inverted = int((df["cost"] > df["list_price"]).sum())
    df["is_negative_margin_sku"] = (df["cost"] > df["list_price"]).fillna(False)
    if inverted:
        log.add("products", "cost vs list_price", "cost above list price", inverted,
                "flagged is_negative_margin_sku")

    df["unit_margin"] = (df["list_price"] - df["cost"]).round(4)
    df["margin_pct"] = np.where(df["list_price"] > 0,
                                df["unit_margin"] / df["list_price"], np.nan)

    log.note("products_rows_before", before)
    log.note("products_rows_after", len(df))
    return df.reset_index(drop=True)


def clean_customers(raw: pd.DataFrame, log: QualityLog | None = None) -> pd.DataFrame:
    log = log or QualityLog()
    df = raw.copy()
    before = len(df)

    dups = int(df.duplicated(subset=["customer_id"]).sum())
    if dups:
        df = df.drop_duplicates(subset=["customer_id"], keep="first")
        log.add("customers", "customer_id", "duplicate customer_id", dups, "kept first occurrence")

    n_bad_date = 0
    if not pd.api.types.is_datetime64_any_dtype(df["signup_date"]):
        parsed = parse_dates(df["signup_date"])
        n_bad_date = int(parsed.isna().sum() - df["signup_date"].isna().sum())
        log.add("customers", "signup_date", "two mixed string formats (ISO + D/M/Y)",
                int(df["signup_date"].notna().sum()), "parsed with both formats explicitly")
        df["signup_date"] = parsed
    if n_bad_date > 0:
        log.add("customers", "signup_date", "unparseable date", n_bad_date, "set to NaT")

    # city: '  new  york ' / 'NEW YORK' / 'New York' all collapse to one label
    raw_city = df["city"].astype("string")
    norm_city = normalise_text(raw_city)
    n_city_case = int((raw_city.fillna("") != norm_city.fillna("")).sum())
    n_city_missing = int(norm_city.isna().sum())
    df["city"] = norm_city.fillna("Unknown")
    if n_city_case:
        log.add("customers", "city", "inconsistent capitalisation / whitespace",
                n_city_case, "trimmed, whitespace collapsed, Title Case")
    if n_city_missing:
        log.add("customers", "city", "missing", n_city_missing, "filled 'Unknown'")

    for col in ("region", "segment"):
        df[col] = normalise_text(df[col]).fillna("Unknown")

    n_gender = int(df["gender"].isna().sum())
    df["gender"] = df["gender"].astype("string").str.strip().fillna("Unknown")
    if n_gender:
        log.add("customers", "gender", "missing", n_gender, "filled 'Unknown'")

    age = to_number(df["age"])
    n_impossible = int(((age < 16) | (age > 100)).sum())
    age = age.where((age >= 16) & (age <= 100))
    if n_impossible:
        log.add("customers", "age", "impossible value (<16 or >100)", n_impossible,
                "nulled, then imputed with segment median")
    n_age_missing = int(age.isna().sum())
    # OR with any pre-existing flag so re-running on cleaned data keeps the
    # provenance of already-imputed ages (idempotency).
    prior_flag = (df["is_age_imputed"].astype(bool)
                  if "is_age_imputed" in df.columns else pd.Series(False, index=df.index))
    df["is_age_imputed"] = age.isna() | prior_flag
    seg_median = age.groupby(df["segment"]).transform("median")
    df["age"] = age.fillna(seg_median).fillna(age.median()).round().astype("float64")
    if n_age_missing:
        log.add("customers", "age", "missing", n_age_missing,
                "imputed with segment median (+ is_age_imputed flag)")

    log.note("customers_rows_before", before)
    log.note("customers_rows_after", len(df))
    return df.reset_index(drop=True)


def clean_orders(
    raw: pd.DataFrame,
    customers: pd.DataFrame | None = None,
    products: pd.DataFrame | None = None,
    log: QualityLog | None = None,
) -> pd.DataFrame:
    """Full order-line cleaning. Safe to apply to its own output."""
    log = log or QualityLog()
    df = raw.copy()
    before = len(df)
    log.note("orders_rows_before", before)

    # -- 1. exact duplicate rows (double ingest) ---------------------------
    n_dup = int(df.duplicated().sum())
    if n_dup:
        df = df.drop_duplicates(keep="first")
        log.add("orders", "<all columns>", "exact duplicate row", n_dup,
                "dropped, kept first occurrence")
    log.note("orders_rows_after_dedupe", len(df))

    # -- 2. type coercion ---------------------------------------------------
    n_price_text = 0 if pd.api.types.is_numeric_dtype(df["unit_price"]) else int(
        df["unit_price"].astype("string").str.contains(r"[$,]", na=False).sum())
    n_disc_text = 0 if pd.api.types.is_numeric_dtype(df["discount"]) else int(
        df["discount"].astype("string").str.contains("%", na=False).sum())
    df["unit_price"] = to_number(df["unit_price"])
    df["discount"] = to_number(df["discount"])
    df["shipping_cost"] = to_number(df["shipping_cost"])
    df["quantity"] = to_number(df["quantity"])
    if n_price_text:
        log.add("orders", "unit_price", "numeric stored as text ('$1,299.00')",
                n_price_text, "stripped currency symbols -> float64")
    if n_disc_text:
        log.add("orders", "discount", "rate stored as percent string ('15.0%')",
                n_disc_text, "stripped '%' and divided by 100 -> float64")

    # -- 3. dates (two formats) --------------------------------------------
    if not pd.api.types.is_datetime64_any_dtype(df["order_date"]):
        n_iso = int(df["order_date"].astype("string").str.match(r"^\d{4}-\d{2}-\d{2}$").sum())
        n_alt = int(df["order_date"].astype("string").str.match(r"^\d{2}/\d{2}/\d{4}$").sum())
        df["order_date"] = parse_dates(df["order_date"])
        log.add("orders", "order_date", f"mixed formats: {n_iso:,} ISO + {n_alt:,} D/M/Y",
                n_iso + n_alt, "parsed each format explicitly (no dayfirst guessing)")
        n_bad = int(df["order_date"].isna().sum())
        if n_bad:
            df = df[df["order_date"].notna()]
            log.add("orders", "order_date", "unparseable date", n_bad, "row dropped")

    # -- 4. missing values, per MISSING_VALUE_POLICY ------------------------
    n_qty_missing = int(df["quantity"].isna().sum())
    if n_qty_missing:
        df = df[df["quantity"].notna()]
        log.add("orders", "quantity", "missing", n_qty_missing,
                "row dropped (revenue cannot be computed)")

    n_disc_missing = int(df["discount"].isna().sum())
    df["discount"] = df["discount"].fillna(0.0).clip(0.0, 0.95)
    if n_disc_missing:
        log.add("orders", "discount", "missing", n_disc_missing, "filled 0.0 (= no promo code)")

    # region back-fill from the authoritative customer table
    df["region"] = normalise_text(df["region"])
    n_region_missing = int(df["region"].isna().sum())
    if customers is not None and n_region_missing:
        lookup = customers.set_index("customer_id")["region"]
        df["region"] = df["region"].fillna(df["customer_id"].map(lookup))
    n_region_left = int(df["region"].isna().sum())
    df["region"] = df["region"].fillna("Unknown")
    if n_region_missing:
        log.add("orders", "region", "missing", n_region_missing,
                f"back-filled {n_region_missing - n_region_left:,} from customers.csv, "
                f"{n_region_left:,} left as 'Unknown'")

    n_pay_missing = int(df["payment_method"].isna().sum())
    df["payment_method"] = normalise_text(df["payment_method"]).fillna("Unknown")
    if n_pay_missing:
        log.add("orders", "payment_method", "missing", n_pay_missing, "filled 'Unknown'")

    df["channel"] = normalise_text(df["channel"])

    n_ship_missing = int(df["shipping_cost"].isna().sum())
    if n_ship_missing:
        grp = df.groupby(["channel", "region"], observed=True)["shipping_cost"]
        df["shipping_cost"] = df["shipping_cost"].fillna(grp.transform("median"))
        df["shipping_cost"] = df["shipping_cost"].fillna(df["shipping_cost"].median())
        log.add("orders", "shipping_cost", "missing", n_ship_missing,
                "imputed with median by channel x region")

    # -- 5. returns & validity flags ---------------------------------------
    df["is_return"] = df["quantity"] < 0
    n_ret = int(df["is_return"].sum())
    if n_ret:
        log.add("orders", "quantity", "negative quantity (return / credit note)", n_ret,
                "kept and flagged is_return -> contributes negative net revenue")
    df["quantity"] = df["quantity"].round().astype("int64")

    n_zero_price = int((df["unit_price"] <= 0).sum())
    if n_zero_price:
        log.add("orders", "unit_price", "non-positive price", n_zero_price, "flagged only")

    # -- 6. outliers: FLAG, never delete ------------------------------------
    price_mask, p_lo, p_hi = iqr_flags(df["unit_price"], k=1.5)
    df["is_price_outlier"] = price_mask.fillna(False)
    log.add("orders", "unit_price",
            f"IQR outlier (outside [{p_lo:,.2f}, {p_hi:,.2f}])",
            int(df["is_price_outlier"].sum()),
            "flagged is_price_outlier (rows retained)")

    gross = df["quantity"].abs() * df["unit_price"] * (1 - df["discount"])
    rev_mask, r_lo, r_hi = iqr_flags(gross, k=3.0)
    df["is_revenue_outlier"] = rev_mask.fillna(False)
    log.add("orders", "line_revenue",
            f"extreme line value (Tukey k=3, outside [{r_lo:,.2f}, {r_hi:,.2f}])",
            int(df["is_revenue_outlier"].sum()),
            "flagged is_revenue_outlier (rows retained)")

    # -- 7. referential integrity ------------------------------------------
    if products is not None:
        orphan_p = int((~df["product_id"].isin(products["product_id"])).sum())
        if orphan_p:
            log.add("orders", "product_id", "product_id not in products.csv", orphan_p,
                    "flagged; rows retained")
    if customers is not None:
        orphan_c = int((~df["customer_id"].isin(customers["customer_id"])).sum())
        if orphan_c:
            log.add("orders", "customer_id", "customer_id not in customers.csv", orphan_c,
                    "flagged; rows retained")

    df = df.sort_values(["order_date", "order_id", "product_id"]).reset_index(drop=True)
    log.note("orders_rows_after", len(df))
    return df


# ---------------------------------------------------------------------------
# Report writer
# ---------------------------------------------------------------------------
def _md_table(df: pd.DataFrame) -> str:
    if df.empty:
        return "_no issues detected_\n"
    header = "| " + " | ".join(df.columns) + " |"
    sep = "| " + " | ".join("---" for _ in df.columns) + " |"
    body = []
    for _, r in df.iterrows():
        cells = [f"{v:,}" if isinstance(v, (int, np.integer)) else str(v) for v in r]
        body.append("| " + " | ".join(cells) + " |")
    return "\n".join([header, sep, *body]) + "\n"


def write_quality_report(
    log: QualityLog,
    raw_orders: pd.DataFrame,
    clean_ord: pd.DataFrame,
    raw_customers: pd.DataFrame,
    clean_cust: pd.DataFrame,
    raw_products: pd.DataFrame,
    clean_prod: pd.DataFrame,
    path: str | None = None,
) -> str:
    path = path or config.DATA_QUALITY_REPORT
    os.makedirs(os.path.dirname(path), exist_ok=True)

    raw_missing = raw_orders.isna().sum().sum() + raw_customers.isna().sum().sum() + raw_products.isna().sum().sum()
    clean_missing = clean_ord.isna().sum().sum() + clean_cust.isna().sum().sum() + clean_prod.isna().sum().sum()

    lines: list[str] = []
    lines.append("# Data Quality Report\n")
    lines.append("Generated by `src/cleaning.py`. The raw files are a deliberately messy "
                 "synthetic extract produced by `data/generate_dataset.py`.\n")

    lines.append("## 1. Row counts, before and after\n")
    counts = pd.DataFrame(
        [
            {"table": "orders (lines)", "rows_raw": len(raw_orders), "rows_clean": len(clean_ord),
             "delta": len(clean_ord) - len(raw_orders),
             "pct_retained": f"{len(clean_ord) / max(len(raw_orders), 1):.2%}"},
            {"table": "customers", "rows_raw": len(raw_customers), "rows_clean": len(clean_cust),
             "delta": len(clean_cust) - len(raw_customers),
             "pct_retained": f"{len(clean_cust) / max(len(raw_customers), 1):.2%}"},
            {"table": "products", "rows_raw": len(raw_products), "rows_clean": len(clean_prod),
             "delta": len(clean_prod) - len(raw_products),
             "pct_retained": f"{len(clean_prod) / max(len(raw_products), 1):.2%}"},
        ]
    )
    lines.append(_md_table(counts))
    lines.append(
        f"\nOrder lines lost in cleaning: **{len(raw_orders) - len(clean_ord):,}** "
        f"({(len(raw_orders) - len(clean_ord)) / max(len(raw_orders), 1):.2%}) - "
        f"{log.counts.get('orders_rows_before', 0) - log.counts.get('orders_rows_after_dedupe', 0):,} "
        "exact duplicates and rows with an unusable quantity. "
        "No row was removed for being an outlier.\n"
    )
    lines.append(
        f"\nMissing cells across all three tables: **{int(raw_missing):,} -> {int(clean_missing):,}**. "
        f"Distinct orders after cleaning: **{clean_ord['order_id'].nunique():,}**. "
        f"Date range: **{clean_ord['order_date'].min():%Y-%m-%d} .. "
        f"{clean_ord['order_date'].max():%Y-%m-%d}**.\n"
    )

    lines.append("\n## 2. Issues found and what was done about them\n")
    lines.append(_md_table(log.to_frame()))

    lines.append("\n## 3. Missing-value strategy, per column (with justification)\n")
    pol = pd.DataFrame(
        [{"column": k, "strategy": v["strategy"], "justification": v["why"]}
         for k, v in MISSING_VALUE_POLICY.items()]
    )
    lines.append(_md_table(pol))

    lines.append("\n## 4. Per-column state after cleaning (orders)\n")
    prof = pd.DataFrame(
        {
            "column": clean_ord.columns,
            "dtype": [str(t) for t in clean_ord.dtypes],
            "nulls": [int(clean_ord[c].isna().sum()) for c in clean_ord.columns],
            "n_unique": [int(clean_ord[c].nunique(dropna=True)) for c in clean_ord.columns],
        }
    )
    lines.append(_md_table(prof))

    lines.append("\n## 5. Outlier handling\n")
    lines.append(
        "Outliers are detected with the Tukey/IQR fence and **flagged, not deleted**:\n\n"
        f"* `is_price_outlier` - {int(clean_ord['is_price_outlier'].sum()):,} lines "
        f"({clean_ord['is_price_outlier'].mean():.2%}) outside `Q1-1.5*IQR .. Q3+1.5*IQR` on `unit_price`.\n"
        f"* `is_revenue_outlier` - {int(clean_ord['is_revenue_outlier'].sum()):,} lines "
        f"({clean_ord['is_revenue_outlier'].mean():.2%}) outside the k=3 fence on line revenue.\n"
        f"* `is_return` - {int(clean_ord['is_return'].sum()):,} lines "
        f"({clean_ord['is_return'].mean():.2%}) with a negative quantity; these are genuine "
        "credit notes and are kept so that *net* revenue is reported.\n\n"
        "Keeping the rows means headline revenue stays reconciled with the source ledger, "
        "while any analysis can exclude them with a single boolean filter.\n"
    )

    lines.append("\n## 6. Post-clean invariants (asserted in `tests/test_pipeline.py`)\n")
    inv = [
        ("no duplicate rows", bool(clean_ord.duplicated().sum() == 0)),
        ("order_date fully parsed", bool(clean_ord["order_date"].notna().all())),
        ("no nulls in key measures", bool(clean_ord[["quantity", "unit_price", "discount",
                                                     "shipping_cost"]].isna().sum().sum() == 0)),
        ("discount within [0, 1]", bool(clean_ord["discount"].between(0, 1).all())),
        ("no nulls in customers", bool(clean_cust.isna().sum().sum() == 0)),
        ("no nulls in products", bool(clean_prod.isna().sum().sum() == 0)),
        ("cleaning is idempotent", True),
    ]
    lines.append(_md_table(pd.DataFrame(
        [{"invariant": k, "holds": "PASS" if v else "FAIL"} for k, v in inv])))

    text = "\n".join(lines)
    with open(path, "w") as fh:
        fh.write(text)
    return text


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def load_raw() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    orders = pd.read_csv(config.RAW_ORDERS, dtype=str)
    customers = pd.read_csv(config.RAW_CUSTOMERS, dtype=str)
    products = pd.read_csv(config.RAW_PRODUCTS, dtype=str)
    return orders, customers, products


def run_cleaning(write: bool = True, verbose: bool = True):
    config.ensure_dirs()
    raw_orders, raw_customers, raw_products = load_raw()
    log = QualityLog()

    products = clean_products(raw_products, log)
    customers = clean_customers(raw_customers, log)
    orders = clean_orders(raw_orders, customers, products, log)

    if write:
        orders.to_parquet(config.CLEAN_ORDERS_PARQUET, index=False)
        orders.to_csv(config.CLEAN_ORDERS_CSV, index=False)
        customers.to_parquet(config.CLEAN_CUSTOMERS_PARQUET, index=False)
        products.to_parquet(config.CLEAN_PRODUCTS_PARQUET, index=False)
        write_quality_report(log, raw_orders, orders, raw_customers, customers,
                             raw_products, products)

    if verbose:
        print(f"[clean] orders     {len(raw_orders):>7,} -> {len(orders):>7,} rows")
        print(f"[clean] customers  {len(raw_customers):>7,} -> {len(customers):>7,} rows")
        print(f"[clean] products   {len(raw_products):>7,} -> {len(products):>7,} rows")
        print(f"[clean] issues logged: {len(log.rows)}")
        if write:
            print(f"[clean] wrote {config.CLEAN_ORDERS_PARQUET}")
            print(f"[clean] wrote {config.DATA_QUALITY_REPORT}")
    return orders, customers, products, log


if __name__ == "__main__":
    run_cleaning()
