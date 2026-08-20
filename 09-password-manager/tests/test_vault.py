"""Tests for vault persistence: atomicity, permissions, backups, locking."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from conftest import MASTER, OTHER_MASTER
from pwmgr.crypto import DecryptionError
from pwmgr.models import Entry
from pwmgr.vault import (
    BACKUP_KEEP,
    Vault,
    VaultError,
    atomic_write,
    file_mode,
    list_backups,
    make_backup,
    read_document,
    vault_path_from,
)


# --- creation and permissions ----------------------------------------------

def test_create_writes_vault_with_0600_permissions(vault_path: Path):
    Vault.create(vault_path, MASTER).lock()
    assert vault_path.exists()
    assert file_mode(vault_path) == 0o600


def test_vault_directory_is_0700(tmp_path: Path):
    target = tmp_path / "nested" / "vault.json"
    Vault.create(target, MASTER).lock()
    assert file_mode(target.parent) == 0o700


def test_saved_vault_keeps_0600_after_rewrite(populated_vault: Vault):
    populated_vault.save()
    populated_vault.save()
    assert file_mode(populated_vault.path) == 0o600


def test_create_refuses_to_clobber_existing_vault(vault_path: Path):
    Vault.create(vault_path, MASTER).lock()
    with pytest.raises(VaultError, match="already exists"):
        Vault.create(vault_path, MASTER)


def test_create_overwrite_flag_replaces_vault(vault_path: Path):
    Vault.create(vault_path, MASTER).lock()
    Vault.create(vault_path, OTHER_MASTER, overwrite=True).lock()
    Vault.open(vault_path, OTHER_MASTER).lock()


# --- round trip -------------------------------------------------------------

def test_save_and_reopen_round_trip(populated_vault: Vault):
    reopened = Vault.open(populated_vault.path, MASTER)
    try:
        assert {e.title for e in reopened.data.entries} == {"GitHub", "Email", "Router"}
        github = reopened.data.find_by_title("GitHub")
        assert github.password == "J8#pQ2!vLm4@Zx7wRt6z"
        assert github.tags == ["dev", "work"]
        assert github.username == "octocat"
    finally:
        reopened.lock()


def test_wrong_master_password_is_rejected(populated_vault: Vault):
    with pytest.raises(DecryptionError, match="wrong master password or corrupted vault"):
        Vault.open(populated_vault.path, "not-the-password")


def test_vault_file_contains_no_plaintext_secrets(populated_vault: Vault):
    raw = populated_vault.path.read_bytes()
    for secret in (b"J8#pQ2!vLm4@Zx7wRt6z", b"octocat", b"GitHub", b"me@example.com", MASTER.encode()):
        assert secret not in raw


def test_vault_file_is_json_with_expected_header(populated_vault: Vault):
    document = json.loads(populated_vault.path.read_text())
    header = document["header"]
    assert header["format"] == "pwmgr-vault"
    assert header["version"] == 1
    assert header["cipher"] == "aes-256-gcm"
    assert header["kdf"]["name"] == "argon2id"
    assert header["kdf"]["memory_cost"] == 64 * 1024
    assert set(document) == {"header", "nonce", "ciphertext"}


def test_each_save_rotates_the_nonce(populated_vault: Vault):
    first = json.loads(populated_vault.path.read_text())["nonce"]
    populated_vault.save()
    second = json.loads(populated_vault.path.read_text())["nonce"]
    assert first != second


# --- tamper detection at the file level ------------------------------------

def test_tampered_header_in_file_is_rejected(populated_vault: Vault):
    document = json.loads(populated_vault.path.read_text())
    document["header"]["kdf"]["time_cost"] = 1  # try to weaken the KDF
    populated_vault.path.write_text(json.dumps(document))
    with pytest.raises(DecryptionError):
        Vault.open(populated_vault.path, MASTER)


def test_tampered_salt_in_file_is_rejected(populated_vault: Vault):
    document = json.loads(populated_vault.path.read_text())
    document["header"]["salt"] = "AAAAAAAAAAAAAAAAAAAAAA=="
    populated_vault.path.write_text(json.dumps(document))
    with pytest.raises(DecryptionError):
        Vault.open(populated_vault.path, MASTER)


def test_tampered_ciphertext_in_file_is_rejected(populated_vault: Vault):
    document = json.loads(populated_vault.path.read_text())
    body = bytearray(__import__("base64").b64decode(document["ciphertext"]))
    body[5] ^= 0xFF
    document["ciphertext"] = __import__("base64").b64encode(bytes(body)).decode()
    populated_vault.path.write_text(json.dumps(document))
    with pytest.raises(DecryptionError):
        Vault.open(populated_vault.path, MASTER)


def test_unknown_format_version_is_rejected(populated_vault: Vault):
    document = json.loads(populated_vault.path.read_text())
    document["header"]["version"] = 99
    populated_vault.path.write_text(json.dumps(document))
    with pytest.raises(VaultError, match="version"):
        Vault.open(populated_vault.path, MASTER)


def test_non_vault_file_is_rejected(tmp_path: Path):
    junk = tmp_path / "junk.json"
    junk.write_text("not a vault at all")
    with pytest.raises(VaultError):
        read_document(junk)


def test_missing_vault_raises_helpful_error(tmp_path: Path):
    with pytest.raises(VaultError, match="no vault at"):
        read_document(tmp_path / "absent.json")


# --- atomic writes and backups ---------------------------------------------

def test_atomic_write_creates_file_with_mode_and_no_temp_left(tmp_path: Path):
    target = tmp_path / "data.bin"
    atomic_write(target, b"hello")
    assert target.read_bytes() == b"hello"
    assert file_mode(target) == 0o600
    assert [p.name for p in tmp_path.iterdir()] == ["data.bin"]


def test_atomic_write_replaces_content_in_place(tmp_path: Path):
    target = tmp_path / "data.bin"
    atomic_write(target, b"first")
    atomic_write(target, b"second")
    assert target.read_bytes() == b"second"
    assert len(list(tmp_path.iterdir())) == 1


def test_atomic_write_leaves_original_intact_on_failure(tmp_path: Path, monkeypatch):
    target = tmp_path / "data.bin"
    atomic_write(target, b"original")

    def boom(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        atomic_write(target, b"replacement")

    assert target.read_bytes() == b"original"
    # the temp file must have been cleaned up
    assert [p.name for p in tmp_path.iterdir()] == ["data.bin"]


def test_backup_created_on_save(vault_path: Path):
    vault = Vault.create(vault_path, MASTER)  # create() itself does not back up
    try:
        assert list_backups(vault_path) == []
        vault.save()
        backups = list_backups(vault_path)
        assert len(backups) == 1
        assert file_mode(backups[0]) == 0o600

        vault.save()
        assert len(list_backups(vault_path)) == 2
    finally:
        vault.lock()


def test_backup_rotation_keeps_only_five(populated_vault: Vault):
    for _ in range(9):
        populated_vault.save()
    backups = list_backups(populated_vault.path)
    assert len(backups) == BACKUP_KEEP == 5


def test_backups_are_newest_first_and_openable(populated_vault: Vault):
    populated_vault.data.add(Entry(title="Later", password="x"))
    populated_vault.save()
    backups = list_backups(populated_vault.path)
    assert backups == sorted(backups, key=lambda p: p.name, reverse=True)

    # The newest backup is the pre-save state: it lacks the new entry.
    restored = Vault.open(backups[0], MASTER)
    try:
        assert restored.data.find_by_title("Later") is None
        assert restored.data.find_by_title("GitHub") is not None
    finally:
        restored.lock()


def test_make_backup_returns_none_when_no_vault_exists(tmp_path: Path):
    assert make_backup(tmp_path / "nothing.json") is None


def test_backup_directory_is_0700(populated_vault: Vault):
    populated_vault.save()
    assert file_mode(list_backups(populated_vault.path)[0].parent) == 0o700


# --- key handling and locking ----------------------------------------------

def test_lock_wipes_the_key_and_clears_entries(populated_vault: Vault):
    key_buffer = populated_vault.key
    populated_vault.lock()
    assert populated_vault.is_locked
    assert not any(key_buffer)
    assert populated_vault.data.entries == []


def test_saving_a_locked_vault_fails(populated_vault: Vault):
    populated_vault.lock()
    with pytest.raises(VaultError, match="locked"):
        populated_vault.save()


def test_context_manager_locks_on_exit(vault_path: Path):
    with Vault.create(vault_path, MASTER) as vault:
        assert not vault.is_locked
    assert vault.is_locked


def test_autolock_triggers_after_idle_period(populated_vault: Vault):
    populated_vault.autolock_minutes = 1 / 60000  # ~1ms
    time.sleep(0.01)
    assert populated_vault.should_autolock()
    assert populated_vault.check_autolock() is True
    assert populated_vault.is_locked


def test_autolock_reset_by_activity(populated_vault: Vault):
    populated_vault.autolock_minutes = 1
    time.sleep(0.01)
    populated_vault.touch()
    assert populated_vault.idle_seconds() < 0.5
    assert populated_vault.check_autolock() is False


def test_autolock_disabled_when_zero(populated_vault: Vault):
    populated_vault.autolock_minutes = 0
    assert populated_vault.should_autolock() is False


# --- master password change -------------------------------------------------

def test_change_master_password_re_encrypts(populated_vault: Vault):
    old_salt = populated_vault.header["salt"]
    populated_vault.change_master_password(OTHER_MASTER)
    assert populated_vault.header["salt"] != old_salt

    reopened = Vault.open(populated_vault.path, OTHER_MASTER)
    try:
        assert {e.title for e in reopened.data.entries} == {"GitHub", "Email", "Router"}
    finally:
        reopened.lock()

    with pytest.raises(DecryptionError):
        Vault.open(populated_vault.path, MASTER)


def test_change_master_password_preserves_created_at(populated_vault: Vault):
    created = populated_vault.header["created_at"]
    populated_vault.change_master_password(OTHER_MASTER)
    assert populated_vault.header["created_at"] == created


# --- export -----------------------------------------------------------------

def test_encrypted_export_is_a_readable_vault(populated_vault: Vault, tmp_path: Path):
    dest = populated_vault.export_encrypted(tmp_path / "export.json")
    assert file_mode(dest) == 0o600
    exported = Vault.open(dest, MASTER)
    try:
        assert {e.title for e in exported.data.entries} == {"GitHub", "Email", "Router"}
    finally:
        exported.lock()
    assert b"J8#pQ2!vLm4@Zx7wRt6z" not in dest.read_bytes()


# --- path resolution --------------------------------------------------------

def test_vault_path_prefers_argument_then_env(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("PWMGR_VAULT", str(tmp_path / "from-env.json"))
    assert vault_path_from(tmp_path / "explicit.json") == tmp_path / "explicit.json"
    assert vault_path_from(None) == tmp_path / "from-env.json"
    monkeypatch.delenv("PWMGR_VAULT")
    assert vault_path_from(None).name == "vault.json"
