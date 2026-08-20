"""Vault hygiene checks: weak passwords, reuse, and stale entries.

The strength scorer is a small hand-rolled heuristic in the spirit of
zxcvbn - it is *not* zxcvbn, and it deliberately errs on the pessimistic
side. It considers length, character variety, membership in a bundled
common-password list, keyboard runs, sequential runs, repeats, and simple
leetspeak variants of common words.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional, Sequence

from .models import Entry, age_days

DATA_DIR = Path(__file__).resolve().parent / "data"
COMMON_PASSWORDS_PATH = DATA_DIR / "common_passwords.txt"

STALE_DAYS = 365
WEAK_SCORE_THRESHOLD = 2  # score 0-4; 0/1/2 are flagged

KEYBOARD_ROWS = (
    "`1234567890-=",
    "qwertyuiop[]\\",
    "asdfghjkl;'",
    "zxcvbnm,./",
    "!@#$%^&*()_+",
)

LEET_MAP = str.maketrans({"0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i"})

SCORE_LABELS = {0: "very weak", 1: "weak", 2: "fair", 3: "strong", 4: "very strong"}


@lru_cache(maxsize=1)
def load_common_passwords(path: Optional[str] = None) -> frozenset[str]:
    """Load the bundled common-password list, lower-cased."""
    target = Path(path) if path else COMMON_PASSWORDS_PATH
    if not target.exists():
        return frozenset()
    return frozenset(
        line.strip().lower()
        for line in target.read_text(encoding="utf-8").splitlines()
        if line.strip()
    )


def _charset_size(password: str) -> int:
    """Size of the alphabet the password appears to be drawn from."""
    size = 0
    if re.search(r"[a-z]", password):
        size += 26
    if re.search(r"[A-Z]", password):
        size += 26
    if re.search(r"[0-9]", password):
        size += 10
    if re.search(r"[^a-zA-Z0-9]", password):
        size += 32
    return size


def entropy_bits(password: str) -> float:
    """Naive entropy of the password, ignoring structure."""
    size = _charset_size(password)
    if not password or size <= 1:
        return 0.0
    return len(password) * math.log2(size)


def _variety(password: str) -> int:
    """How many of the four character classes are present (0-4)."""
    return sum(
        bool(re.search(pattern, password))
        for pattern in (r"[a-z]", r"[A-Z]", r"[0-9]", r"[^a-zA-Z0-9]")
    )


def has_keyboard_pattern(password: str, min_run: int = 4) -> bool:
    """True if the password contains a straight run along a keyboard row."""
    low = password.lower()
    for row in KEYBOARD_ROWS:
        reversed_row = row[::-1]
        for start in range(len(row) - min_run + 1):
            run = row[start : start + min_run]
            if run in low or reversed_row[start : start + min_run] in low:
                return True
    return False


def has_sequence(password: str, min_run: int = 4) -> bool:
    """True if it contains an ascending/descending run like 'abcd' or '4321'."""
    if len(password) < min_run:
        return False
    low = password.lower()
    run_up = run_down = 1
    for i in range(1, len(low)):
        delta = ord(low[i]) - ord(low[i - 1])
        run_up = run_up + 1 if delta == 1 else 1
        run_down = run_down + 1 if delta == -1 else 1
        if run_up >= min_run or run_down >= min_run:
            return True
    return False


def has_repeats(password: str, min_run: int = 3) -> bool:
    """True if a single character repeats ``min_run`` times in a row."""
    return re.search(r"(.)\1{" + str(min_run - 1) + r",}", password) is not None


def _candidates(password: str) -> List[str]:
    """Normalisations to test against the common list.

    Covers the password as typed, its leetspeak-decoded form, and both of
    those with trailing digits/punctuation removed - so 'P@ssw0rd', and
    'Password123!' all reduce to 'password'.
    """
    low = password.lower()
    forms = {low, low.translate(LEET_MAP)}
    for form in list(forms):
        trimmed = re.sub(r"[\d\W_]+$", "", form)
        if trimmed:
            forms.add(trimmed)
    return [f for f in forms if f]


def is_common(password: str) -> bool:
    """True if the password (or its obvious dress-up) is on the common list."""
    commons = load_common_passwords()
    return any(form in commons for form in _candidates(password))


@dataclass
class Strength:
    """Result of scoring a single password."""

    score: int  # 0 (worst) .. 4 (best)
    entropy: float
    warnings: List[str] = field(default_factory=list)
    suggestions: List[str] = field(default_factory=list)

    @property
    def label(self) -> str:
        return SCORE_LABELS.get(self.score, "unknown")

    @property
    def is_weak(self) -> bool:
        return self.score <= WEAK_SCORE_THRESHOLD


def score_password(password: str) -> Strength:
    """Score a password from 0 (terrible) to 4 (very strong)."""
    warnings: List[str] = []
    suggestions: List[str] = []

    if not password:
        return Strength(0, 0.0, ["empty password"], ["set a password"])

    bits = entropy_bits(password)
    length = len(password)
    variety = _variety(password)

    # Start from entropy alone.
    if bits < 28:
        score = 0
    elif bits < 40:
        score = 1
    elif bits < 60:
        score = 2
    elif bits < 80:
        score = 3
    else:
        score = 4

    if length < 8:
        score = min(score, 1)
        warnings.append("shorter than 8 characters")
        suggestions.append("use at least 12-16 characters")
    elif length < 12:
        score = min(score, 2)
        suggestions.append("use at least 12-16 characters")

    if variety <= 1:
        score = min(score, 1)
        warnings.append("uses only one character class")
        suggestions.append("mix upper, lower, digits and symbols")
    elif variety == 2 and length < 16:
        score = min(score, 2)
        suggestions.append("mix upper, lower, digits and symbols")

    if is_common(password):
        score = 0
        warnings.append("appears in the common-password list")
        suggestions.append("pick something that is not a known password")

    if has_keyboard_pattern(password):
        score = min(score, 1)
        warnings.append("contains a keyboard pattern")

    if has_sequence(password):
        score = min(score, 1)
        warnings.append("contains a character sequence")

    if has_repeats(password):
        score = min(score, 2)
        warnings.append("contains repeated characters")

    if score <= WEAK_SCORE_THRESHOLD and not suggestions:
        suggestions.append("regenerate with 'pwmgr gen'")

    return Strength(max(0, min(4, score)), bits, warnings, suggestions)


# --- vault-wide findings ----------------------------------------------------

@dataclass
class Finding:
    """One problem found in the vault."""

    kind: str  # 'weak' | 'reused' | 'stale' | 'empty'
    entry_title: str
    detail: str
    severity: str = "medium"  # 'low' | 'medium' | 'high'


@dataclass
class AuditReport:
    """Everything the audit found, plus the per-entry strengths."""

    findings: List[Finding] = field(default_factory=list)
    strengths: Dict[str, Strength] = field(default_factory=dict)
    total_entries: int = 0

    def of_kind(self, kind: str) -> List[Finding]:
        return [f for f in self.findings if f.kind == kind]

    @property
    def weak(self) -> List[Finding]:
        return self.of_kind("weak")

    @property
    def reused(self) -> List[Finding]:
        return self.of_kind("reused")

    @property
    def stale(self) -> List[Finding]:
        return self.of_kind("stale")

    @property
    def ok(self) -> bool:
        return not self.findings


def find_reused(entries: Sequence[Entry]) -> Dict[str, List[str]]:
    """Map each duplicated password to the titles sharing it.

    Empty passwords are ignored - they are reported separately as 'empty'
    rather than as a hundred-way reuse cluster.
    """
    buckets: Dict[str, List[str]] = defaultdict(list)
    for entry in entries:
        if entry.password:
            buckets[entry.password].append(entry.title)
    return {pw: titles for pw, titles in buckets.items() if len(titles) > 1}


def audit_entries(entries: Sequence[Entry], stale_days: int = STALE_DAYS) -> AuditReport:
    """Run every check over the vault's entries."""
    report = AuditReport(total_entries=len(entries))

    for entry in entries:
        strength = score_password(entry.password)
        report.strengths[entry.id] = strength

        if not entry.password:
            report.findings.append(
                Finding("empty", entry.title, "entry has no password stored", "low")
            )
            continue

        if strength.is_weak:
            detail = f"{strength.label} ({strength.entropy:.0f} bits)"
            if strength.warnings:
                detail += ": " + "; ".join(strength.warnings)
            report.findings.append(
                Finding("weak", entry.title, detail, "high" if strength.score == 0 else "medium")
            )

    for _password, titles in find_reused(entries).items():
        shared = sorted(titles)
        for title in shared:
            others = [t for t in shared if t != title]
            report.findings.append(
                Finding("reused", title, "same password as: " + ", ".join(others), "high")
            )

    for entry in entries:
        age = age_days(entry.updated_at)
        if age > stale_days:
            report.findings.append(
                Finding("stale", entry.title, f"not updated in {int(age)} days", "low")
            )

    return report
