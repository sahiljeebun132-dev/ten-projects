"""Synthetic customer-churn dataset generator (fully offline, fixed seed).

The target is *not* a rule of thumb pasted on top of the features: it is drawn
from a genuine latent logistic process

    logit(p_i) = beta_0 + f(x_i) + interactions + eps_i ,   y_i ~ Bernoulli(p_i)

with an unobserved heterogeneity term ``eps_i`` so that the Bayes-optimal
classifier is well short of perfect (test ROC-AUC lands in the mid-0.80s).
The intercept ``beta_0`` is calibrated by bisection so that the realised churn
rate matches ``config.TARGET_CHURN_RATE`` (~26%).

Deliberate realism:

* missing values are injected *after* the target is drawn, so missingness never
  encodes the label directly (it is missing-at-random conditional on tenure /
  contract, which is what real billing exports look like);
* two "red herring" columns are included whose names smell like leakage
  (``churn_risk_score_v0``, ``account_flagged_for_review``) but which are drawn
  independently of the latent process and therefore carry no signal at all.

Run:  python data/generate_data.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import config  # noqa: E402


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-z))


def _calibrate_intercept(base_logit: np.ndarray, target_rate: float) -> float:
    """Bisection on the intercept so that mean(sigmoid(base + b0)) == target."""
    lo, hi = -12.0, 12.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        rate = _sigmoid(base_logit + mid).mean()
        if rate > target_rate:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


def _mask(rng: np.random.Generator, prob: np.ndarray | float, n: int) -> np.ndarray:
    return rng.random(n) < prob


# --------------------------------------------------------------------------- #
# generator
# --------------------------------------------------------------------------- #
def generate(n_rows: int = config.N_ROWS, seed: int = config.RANDOM_SEED) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    n = n_rows

    # ---------------- customer demographics / account facts ---------------- #
    customer_id = np.array([f"CUST-{i:06d}" for i in range(1, n + 1)])

    # Tenure: mixture of a young cohort and a long-lived cohort.
    young = rng.gamma(shape=1.6, scale=7.0, size=n)
    old = rng.normal(loc=52.0, scale=13.0, size=n)
    is_old = rng.random(n) < 0.38
    tenure = np.where(is_old, old, young)
    tenure_months = np.clip(np.round(tenure), 1, 72).astype(int)

    is_senior = (rng.random(n) < 0.16).astype(int)
    num_dependents = rng.poisson(0.45 + 0.25 * (1 - is_senior), size=n).clip(0, 6)

    region = rng.choice(
        config.CATEGORY_LEVELS["region"], size=n, p=[0.28, 0.30, 0.22, 0.20]
    )

    # Contract: longer tenure customers are much more likely to be on long terms.
    p_m2m = _sigmoid(1.55 - 0.052 * tenure_months)
    p_two = _sigmoid(-1.75 + 0.040 * tenure_months)
    stack = np.vstack([p_m2m, np.full(n, 0.55), p_two]).T
    stack = stack / stack.sum(axis=1, keepdims=True)
    contract_idx = np.array([rng.choice(3, p=row) for row in stack])
    contract_type = np.array(config.CATEGORY_LEVELS["contract_type"])[contract_idx]

    # Internet service.
    internet_service = rng.choice(
        config.CATEGORY_LEVELS["internet_service"], size=n, p=[0.36, 0.46, 0.18]
    )
    has_internet = internet_service != "No internet service"

    # Payment method: month-to-month customers over-index on electronic check.
    pay_levels = config.CATEGORY_LEVELS["payment_method"]
    base_p = np.tile(np.array([0.30, 0.22, 0.24, 0.24]), (n, 1))
    base_p[contract_type == "Month-to-month"] += np.array([0.16, 0.02, -0.09, -0.09])
    base_p[contract_type == "Two year"] += np.array([-0.14, -0.02, 0.08, 0.08])
    base_p = np.clip(base_p, 0.02, None)
    base_p /= base_p.sum(axis=1, keepdims=True)
    payment_method = np.array(
        [pay_levels[rng.choice(4, p=row)] for row in base_p]
    )

    has_streaming = np.where(
        has_internet, (rng.random(n) < 0.52).astype(int), 0
    ).astype(int)

    # ---------------- billing ---------------- #
    monthly_charges = (
        22.0
        + 26.0 * (internet_service == "DSL")
        + 48.0 * (internet_service == "Fiber optic")
        + 11.0 * has_streaming
        + 3.4 * num_dependents
        + rng.normal(0, 6.5, size=n)
    )
    monthly_charges = np.clip(monthly_charges, 15.0, 200.0).round(2)

    # Total charges is *not* a leak: it is monthly * tenure with drift/noise,
    # i.e. a deterministic-ish function of two features that are already present.
    drift = rng.normal(1.0, 0.06, size=n)
    total_charges = (
        monthly_charges * tenure_months * drift + rng.normal(0, 25.0, size=n)
    )
    total_charges = np.clip(total_charges, 0.0, None).round(2)

    # ---------------- behaviour ---------------- #
    usage_mu = np.where(
        internet_service == "Fiber optic",
        340.0,
        np.where(internet_service == "DSL", 160.0, 12.0),
    ) * (1.0 + 0.30 * has_streaming)
    avg_monthly_usage_gb = np.clip(
        rng.lognormal(mean=np.log(usage_mu), sigma=0.42), 0.0, 2_000.0
    ).round(1)

    ticket_rate = (
        0.35
        + 0.55 * (internet_service == "Fiber optic")
        + 0.22 * (contract_type == "Month-to-month")
        + 0.20 * is_senior
        - 0.004 * tenure_months
    ).clip(0.05, None)
    num_support_tickets = rng.poisson(ticket_rate, size=n).clip(0, 30)

    last_login_days = np.clip(
        rng.gamma(shape=1.5, scale=9.0, size=n)
        + 22.0 * (internet_service == "No internet service")
        + rng.normal(0, 3.0, size=n),
        0,
        365,
    ).round().astype(int)

    # ---------------- red herrings (independent of the target) ---------------- #
    # Legacy scoring column whose *name* screams leakage; it is uniform noise.
    churn_risk_score_v0 = rng.uniform(0, 100, size=n).round(2)
    # Back-office review flag, assigned by an unrelated finance workflow.
    account_flagged_for_review = (rng.random(n) < 0.09).astype(int)

    # ---------------- latent logistic churn process ---------------- #
    z_charges = (monthly_charges - monthly_charges.mean()) / monthly_charges.std()
    log_usage = np.log1p(avg_monthly_usage_gb)
    z_usage = (log_usage - log_usage.mean()) / log_usage.std()

    m2m = (contract_type == "Month-to-month").astype(float)
    one_year = (contract_type == "One year").astype(float)
    two_year = (contract_type == "Two year").astype(float)
    fiber = (internet_service == "Fiber optic").astype(float)
    echeck = (payment_method == "Electronic check").astype(float)

    logit = (
        # tenure: strong, non-linear loyalty effect
        -1.15 * np.log1p(tenure_months)
        # price sensitivity
        + 0.45 * z_charges
        # contract main effects
        + 0.95 * m2m
        - 0.30 * one_year
        - 0.85 * two_year
        # service quality proxies
        + 0.34 * fiber
        + 0.28 * echeck
        + 0.30 * num_support_tickets
        # engagement / recency
        + 0.030 * last_login_days
        - 0.18 * z_usage
        # demographics
        + 0.26 * is_senior
        - 0.22 * num_dependents
        - 0.14 * has_streaming
        # small regional effects
        + 0.16 * (region == "South")
        - 0.12 * (region == "North")
        # ---- interactions (this is what makes trees beat a plain GLM) ----
        + 0.55 * m2m * np.maximum(z_charges, 0.0)          # expensive & no lock-in
        + 0.20 * m2m * num_support_tickets                 # friction w/o lock-in
        + 0.42 * np.maximum(z_charges, 0) * np.maximum(-z_usage, 0)  # pays a lot, uses little
        - 0.020 * two_year * last_login_days               # locked-in customers idle safely
        + 0.30 * fiber * (num_support_tickets >= 2)        # fibre outages
        # unobserved heterogeneity
        + rng.normal(0, 0.85, size=n)
    )

    beta0 = _calibrate_intercept(logit, config.TARGET_CHURN_RATE)
    p_churn = _sigmoid(logit + beta0)
    churn = (rng.random(n) < p_churn).astype(int)

    df = pd.DataFrame(
        {
            "customer_id": customer_id,
            "tenure_months": tenure_months,
            "monthly_charges": monthly_charges,
            "total_charges": total_charges,
            "contract_type": contract_type,
            "payment_method": payment_method,
            "internet_service": internet_service,
            "num_support_tickets": num_support_tickets,
            "avg_monthly_usage_gb": avg_monthly_usage_gb,
            "has_streaming": has_streaming,
            "is_senior": is_senior,
            "num_dependents": num_dependents,
            "region": region,
            "last_login_days": last_login_days,
            "churn_risk_score_v0": churn_risk_score_v0,
            "account_flagged_for_review": account_flagged_for_review,
            "churn": churn,
        }
    )

    # ---------------- missingness (injected AFTER the label) ---------------- #
    # 1) total_charges: brand-new accounts have not been billed yet.
    p_missing_total = np.where(df["tenure_months"] <= 2, 0.55, 0.012)
    df.loc[_mask(rng, p_missing_total, n), "total_charges"] = np.nan
    # 2) usage telemetry drops out for a slice of the estate.
    df.loc[_mask(rng, 0.041, n), "avg_monthly_usage_gb"] = np.nan
    # 3) last_login is unknown for accounts without a portal login.
    p_missing_login = np.where(df["internet_service"] == "No internet service", 0.10, 0.026)
    df.loc[_mask(rng, p_missing_login, n), "last_login_days"] = np.nan
    # 4) a small slice of CRM rows lost the product code.
    df.loc[_mask(rng, 0.015, n), "internet_service"] = np.nan
    # 5) dependants occasionally unknown.
    df.loc[_mask(rng, 0.008, n), "num_dependents"] = np.nan

    return df


def write_sample_payloads(df: pd.DataFrame) -> None:
    """Persist a single-record JSON and a small CSV for the predict CLI / API."""
    record = df.drop(columns=[config.TARGET]).iloc[0].to_dict()
    clean = {}
    for k, v in record.items():
        if pd.isna(v):
            clean[k] = None
        elif isinstance(v, (np.integer,)):
            clean[k] = int(v)
        elif isinstance(v, (np.floating,)):
            clean[k] = float(v)
        else:
            clean[k] = v
    config.SAMPLE_INPUT_PATH.write_text(json.dumps(clean, indent=2) + "\n")

    sample = df.drop(columns=[config.TARGET]).head(25)
    sample.to_csv(config.SAMPLE_BATCH_PATH, index=False)


def main() -> None:
    df = generate()
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(config.RAW_DATA_PATH, index=False)
    write_sample_payloads(df)

    print(f"wrote {config.RAW_DATA_PATH}  rows={len(df):,}  cols={df.shape[1]}")
    print(f"churn rate: {df[config.TARGET].mean():.4f}")
    print("missing values per column:")
    miss = df.isna().sum()
    for col, cnt in miss[miss > 0].items():
        print(f"  {col:<28} {cnt:>5}  ({cnt / len(df):.2%})")


if __name__ == "__main__":
    main()
