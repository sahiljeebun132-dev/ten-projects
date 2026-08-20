"""Central paths + a couple of project-wide constants."""
from __future__ import annotations

import os

SRC_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SRC_DIR)

DATA_DIR = os.path.join(PROJECT_ROOT, "data")
RAW_DIR = os.path.join(DATA_DIR, "raw")
PROCESSED_DIR = os.path.join(DATA_DIR, "processed")

REPORTS_DIR = os.path.join(PROJECT_ROOT, "reports")
FIGURES_DIR = os.path.join(REPORTS_DIR, "figures")

RAW_ORDERS = os.path.join(RAW_DIR, "orders.csv")
RAW_CUSTOMERS = os.path.join(RAW_DIR, "customers.csv")
RAW_PRODUCTS = os.path.join(RAW_DIR, "products.csv")

CLEAN_ORDERS_PARQUET = os.path.join(PROCESSED_DIR, "clean_orders.parquet")
CLEAN_ORDERS_CSV = os.path.join(PROCESSED_DIR, "clean_orders.csv")
CLEAN_CUSTOMERS_PARQUET = os.path.join(PROCESSED_DIR, "clean_customers.parquet")
CLEAN_PRODUCTS_PARQUET = os.path.join(PROCESSED_DIR, "clean_products.parquet")
FEATURES_ORDERS_PARQUET = os.path.join(PROCESSED_DIR, "order_features.parquet")
CUSTOMER_FEATURES_PARQUET = os.path.join(PROCESSED_DIR, "customer_features.parquet")

DATA_QUALITY_REPORT = os.path.join(REPORTS_DIR, "data_quality_report.md")
FINDINGS_REPORT = os.path.join(REPORTS_DIR, "findings.md")

# Analysis snapshot date = the day after the last order in the ledger.
# Everything recency-based (RFM, churn risk) is measured against it.
ANALYSIS_ASOF = "2026-01-01"

ALPHA = 0.05          # significance level used throughout the stats section


def ensure_dirs() -> None:
    for d in (PROCESSED_DIR, REPORTS_DIR, FIGURES_DIR):
        os.makedirs(d, exist_ok=True)
