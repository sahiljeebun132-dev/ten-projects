"""Tests for the entry/vault data model."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from pwmgr.models import Entry, VaultData, age_days, parse_iso, utcnow_iso


def test_new_entry_gets_id_and_timestamps():
    entry = Entry(title="A")
    assert len(entry.id) == 32
    assert entry.created_at == entry.updated_at
    assert entry.created_at.endswith("Z")


def test_entry_ids_are_unique():
    assert len({Entry(title=str(i)).id for i in range(100)}) == 100


def test_touch_updates_only_updated_at():
    entry = Entry(title="A", created_at="2020-01-01T00:00:00Z", updated_at="2020-01-01T00:00:00Z")
    entry.touch()
    assert entry.created_at == "2020-01-01T00:00:00Z"
    assert entry.updated_at != "2020-01-01T00:00:00Z"


def test_entry_dict_round_trip():
    original = Entry(title="A", username="u", password="p", url="x", notes="n",
                     tags=["t1", "t2"], totp_secret="GEZDGNBVGY3TQOJQ")
    restored = Entry.from_dict(original.to_dict())
    assert restored.to_dict() == original.to_dict()


def test_from_dict_tolerates_missing_fields():
    entry = Entry.from_dict({"title": "Only a title"})
    assert entry.title == "Only a title"
    assert entry.username == entry.password == ""
    assert entry.tags == []
    assert entry.created_at == entry.updated_at


def test_from_dict_parses_comma_separated_tags():
    assert Entry.from_dict({"title": "A", "tags": "one, two ,three"}).tags == ["one", "two", "three"]


def test_from_dict_coerces_non_string_values():
    entry = Entry.from_dict({"title": 42, "username": None, "password": 1234})
    assert entry.title == "42" and entry.username == "" and entry.password == "1234"


def test_matches_searches_metadata_case_insensitively():
    entry = Entry(title="GitHub", username="Octocat", url="https://github.com",
                  notes="work account", tags=["Dev"])
    for needle in ("github", "OCTO", "gitHub.com", "work", "dev"):
        assert entry.matches(needle)


def test_matches_never_searches_secrets():
    entry = Entry(title="A", password="s3cr3t-value", totp_secret="GEZDGNBVGY3TQOJQ")
    assert not entry.matches("s3cr3t-value")
    assert not entry.matches("GEZDGNBV")


def test_vault_add_and_find():
    vault = VaultData()
    vault.add(Entry(title="GitHub"))
    assert vault.find_by_title("github") is not None
    assert vault.find(vault.entries[0].id) is not None
    assert vault.find("missing") is None


def test_vault_rejects_duplicate_titles():
    vault = VaultData()
    vault.add(Entry(title="Dup"))
    with pytest.raises(ValueError, match="already exists"):
        vault.add(Entry(title="dup"))


def test_vault_remove():
    vault = VaultData()
    vault.add(Entry(title="A"))
    assert vault.remove("A") is True
    assert vault.entries == []
    assert vault.remove("A") is False


def test_vault_search_returns_all_matches():
    vault = VaultData()
    vault.add(Entry(title="Work Mail", tags=["work"]))
    vault.add(Entry(title="Work Chat", tags=["work"]))
    vault.add(Entry(title="Personal", tags=["home"]))
    assert len(vault.search("work")) == 2


def test_vault_dict_round_trip():
    vault = VaultData()
    vault.add(Entry(title="A", password="p"))
    restored = VaultData.from_dict(vault.to_dict())
    assert [e.to_dict() for e in restored.entries] == [e.to_dict() for e in vault.entries]


def test_parse_iso_handles_z_and_offsets():
    assert parse_iso("2024-01-01T00:00:00Z").tzinfo == timezone.utc
    assert parse_iso("2024-01-01T00:00:00+00:00") == parse_iso("2024-01-01T00:00:00Z")
    assert parse_iso("2024-01-01T00:00:00") == parse_iso("2024-01-01T00:00:00Z")


def test_age_days():
    now = datetime.now(timezone.utc)
    old = (now - timedelta(days=400)).isoformat().replace("+00:00", "Z")
    assert 399 < age_days(old, now=now) < 401
    assert age_days(utcnow_iso(), now=now) < 1


def test_age_days_of_garbage_is_zero():
    assert age_days("not a date") == 0.0
    assert age_days("") == 0.0
