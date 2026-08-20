"""Tests for the password strength heuristic and vault-wide audit."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from pwmgr.audit import (
    STALE_DAYS,
    audit_entries,
    entropy_bits,
    find_reused,
    has_keyboard_pattern,
    has_repeats,
    has_sequence,
    is_common,
    load_common_passwords,
    score_password,
)
from pwmgr.models import Entry


def days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat().replace("+00:00", "Z")


# --- the bundled list -------------------------------------------------------

def test_common_password_list_is_bundled():
    commons = load_common_passwords()
    assert len(commons) > 100
    assert "password" in commons and "123456" in commons and "qwerty" in commons


@pytest.mark.parametrize("password", ["password", "123456", "qwerty", "letmein", "admin", "iloveyou"])
def test_common_passwords_are_detected(password):
    assert is_common(password)


@pytest.mark.parametrize("password", ["P@ssw0rd", "PASSWORD", "Password123!", "letmein99", "dragon!!"])
def test_common_passwords_are_detected_through_decoration(password):
    """Leetspeak and trailing digits/symbols must not hide a known password."""
    assert is_common(password)


@pytest.mark.parametrize("password", ["x9$Kq2!vLm8@Zp4wRt6#", "correct-horse-battery-staple"])
def test_strong_passwords_are_not_flagged_as_common(password):
    assert not is_common(password)


# --- individual heuristics --------------------------------------------------

@pytest.mark.parametrize("password", ["qwerty", "asdfgh", "zxcvbn", "MyQwertyPass", "poiuy"])
def test_keyboard_patterns_detected(password):
    assert has_keyboard_pattern(password)


@pytest.mark.parametrize("password", ["x9$Kq2!vLm8", "purple-monkey"])
def test_keyboard_patterns_not_over_detected(password):
    assert not has_keyboard_pattern(password)


@pytest.mark.parametrize("password", ["abcd", "1234", "wxyz99", "hello4321"])
def test_sequences_detected(password):
    assert has_sequence(password)


@pytest.mark.parametrize("password", ["acbd", "1357", "x9$Kq2!v"])
def test_sequences_not_over_detected(password):
    assert not has_sequence(password)


@pytest.mark.parametrize("password", ["aaa", "pass111word", "hellooooo"])
def test_repeats_detected(password):
    assert has_repeats(password)


def test_repeats_not_over_detected():
    assert not has_repeats("aabbcc")


def test_entropy_grows_with_length_and_variety():
    assert entropy_bits("aaaaaaaa") < entropy_bits("aaaaaaaaaaaaaaaa")
    assert entropy_bits("abcdefgh") < entropy_bits("aBc1!efg")
    assert entropy_bits("") == 0.0


# --- scoring ----------------------------------------------------------------

@pytest.mark.parametrize("password", [
    "password", "123456", "qwerty", "abc", "letmein", "aaaaaaaa", "Password123!", "12345678",
])
def test_weak_passwords_score_low(password):
    strength = score_password(password)
    assert strength.is_weak, f"{password!r} scored {strength.score}"
    assert strength.score <= 2


@pytest.mark.parametrize("password", [
    "x9$Kq2!vLm8@Zp4wRt6#",
    "correct-horse-battery-staple-42",
    "8Hd#kL2@wQ9!zXn5&pT7",
    "vault-anchor-melody-tiger-orbit-77",
])
def test_strong_passwords_score_high(password):
    strength = score_password(password)
    assert not strength.is_weak
    assert strength.score >= 3


def test_empty_password_scores_zero_with_a_warning():
    strength = score_password("")
    assert strength.score == 0
    assert strength.entropy == 0.0
    assert "empty password" in strength.warnings


def test_score_is_always_in_range_and_labelled():
    for password in ["", "a", "abc123", "password", "x9$Kq2!vLm8@Zp4wRt6#", "z" * 200]:
        strength = score_password(password)
        assert 0 <= strength.score <= 4
        assert strength.label in {"very weak", "weak", "fair", "strong", "very strong"}


def test_weak_passwords_come_with_actionable_advice():
    strength = score_password("password")
    assert strength.warnings
    assert strength.suggestions


def test_short_password_is_capped_even_with_full_variety():
    assert score_password("aB3!x").score <= 1


def test_single_character_class_is_penalised():
    strength = score_password("abcdefghijklmnop")
    assert strength.score <= 1
    assert "uses only one character class" in strength.warnings


# --- reuse detection --------------------------------------------------------

def test_find_reused_groups_duplicates():
    entries = [
        Entry(title="A", password="shared-secret-1"),
        Entry(title="B", password="shared-secret-1"),
        Entry(title="C", password="unique-secret-2"),
    ]
    reused = find_reused(entries)
    assert list(reused) == ["shared-secret-1"]
    assert sorted(reused["shared-secret-1"]) == ["A", "B"]


def test_find_reused_ignores_empty_passwords():
    entries = [Entry(title="A", password=""), Entry(title="B", password="")]
    assert find_reused(entries) == {}


def test_find_reused_returns_nothing_when_all_unique():
    entries = [Entry(title=str(i), password=f"unique-{i}-x9$Kq") for i in range(5)]
    assert find_reused(entries) == {}


# --- whole-vault audit ------------------------------------------------------

def test_audit_flags_weak_reused_and_stale():
    entries = [
        Entry(title="Weak", password="password"),
        Entry(title="Reuse1", password="Sh4red!Passw0rd#xyz9"),
        Entry(title="Reuse2", password="Sh4red!Passw0rd#xyz9"),
        Entry(title="Stale", password="x9$Kq2!vLm8@Zp4wRt6#", updated_at=days_ago(400)),
        Entry(title="Fine", password="8Hd#kL2@wQ9!zXn5&pT7"),
    ]
    report = audit_entries(entries)

    assert report.total_entries == 5
    assert [f.entry_title for f in report.weak] == ["Weak"]
    assert {f.entry_title for f in report.reused} == {"Reuse1", "Reuse2"}
    assert [f.entry_title for f in report.stale] == ["Stale"]
    assert not report.ok


def test_reuse_finding_names_the_other_entries():
    entries = [Entry(title="A", password="Sh4red!x9"), Entry(title="B", password="Sh4red!x9")]
    finding = next(f for f in audit_entries(entries).reused if f.entry_title == "A")
    assert "B" in finding.detail
    assert finding.severity == "high"


def test_audit_reports_clean_vault():
    entries = [
        Entry(title="A", password="x9$Kq2!vLm8@Zp4wRt6#"),
        Entry(title="B", password="8Hd#kL2@wQ9!zXn5&pT7"),
    ]
    report = audit_entries(entries)
    assert report.ok
    assert report.findings == []


def test_audit_empty_vault():
    report = audit_entries([])
    assert report.total_entries == 0
    assert report.ok


def test_audit_flags_entries_with_no_password():
    report = audit_entries([Entry(title="NoPassword", password="")])
    assert [f.entry_title for f in report.of_kind("empty")] == ["NoPassword"]
    assert report.weak == [], "an empty entry is reported as 'empty', not 'weak'"


def test_stale_threshold_is_configurable():
    entries = [Entry(title="Old", password="x9$Kq2!vLm8@Zp4wRt6#", updated_at=days_ago(100))]
    assert audit_entries(entries, stale_days=STALE_DAYS).stale == []
    assert [f.entry_title for f in audit_entries(entries, stale_days=30).stale] == ["Old"]


def test_fresh_entries_are_never_stale():
    entries = [Entry(title="New", password="x9$Kq2!vLm8@Zp4wRt6#", updated_at=days_ago(364))]
    assert audit_entries(entries).stale == []


def test_report_exposes_strength_per_entry():
    weak = Entry(title="Weak", password="password")
    strong = Entry(title="Strong", password="x9$Kq2!vLm8@Zp4wRt6#")
    report = audit_entries([weak, strong])
    assert report.strengths[weak.id].score == 0
    assert report.strengths[strong.id].score == 4
