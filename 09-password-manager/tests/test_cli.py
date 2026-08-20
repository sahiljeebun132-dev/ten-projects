"""End-to-end tests driving the CLI exactly as a user (or script) would."""

from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

from conftest import MASTER, OTHER_MASTER, RFC_SECRET_B32, run_cli
from pwmgr.vault import Vault, file_mode, list_backups

STRONG = "Zq7#mK2!wR9@tL4x"
STRONG2 = "Pv3&nB8^cX1*hJ6q"


@pytest.fixture
def cli(monkeypatch, tmp_path):
    """Run the CLI against an isolated vault path."""
    path = tmp_path / "vault.json"

    def _run(*argv, stdin=None, vault=path):
        return run_cli(["--vault", str(vault), *argv], monkeypatch, stdin)

    _run.path = path
    return _run


@pytest.fixture
def initialised(cli):
    assert cli("init", stdin=[MASTER, MASTER]) == 0
    return cli


# --- init -------------------------------------------------------------------

def test_init_creates_vault_with_correct_permissions(cli):
    assert cli("init", stdin=[MASTER, MASTER]) == 0
    assert cli.path.exists()
    assert file_mode(cli.path) == 0o600


def test_init_rejects_mismatched_confirmation(cli):
    assert cli("init", stdin=[MASTER, "different"]) != 0
    assert not cli.path.exists()


def test_init_rejects_weak_master_password(cli):
    assert cli("init", stdin=["password", "password"]) != 0
    assert not cli.path.exists()


def test_init_force_accepts_weak_master_password(cli):
    assert cli("init", "--force", stdin=["hunter2", "hunter2"]) == 0
    assert cli.path.exists()


def test_init_refuses_to_overwrite_existing_vault(initialised):
    assert initialised("init", stdin=[OTHER_MASTER, OTHER_MASTER]) != 0
    Vault.open(initialised.path, MASTER).lock()  # original still opens


# --- add / list / get / search ---------------------------------------------

def test_add_and_list(initialised, capsys):
    assert initialised("add", "GitHub", "--username", "octocat", "--password", STRONG,
                       "--url", "https://github.com", "--tags", "dev,work", stdin=[MASTER]) == 0
    capsys.readouterr()
    assert initialised("list", stdin=[MASTER]) == 0
    out = capsys.readouterr().out
    assert "GitHub" in out and "octocat" in out
    assert STRONG not in out, "passwords must be masked by default"


def test_add_rejects_duplicate_titles(initialised):
    assert initialised("add", "Dup", "--password", STRONG, stdin=[MASTER]) == 0
    assert initialised("add", "Dup", "--password", STRONG2, stdin=[MASTER]) != 0


def test_add_with_generate_stores_a_strong_password(initialised):
    assert initialised("add", "Gen", "--generate", "--length", "24", stdin=[MASTER]) == 0
    vault = Vault.open(initialised.path, MASTER)
    try:
        assert len(vault.data.find_by_title("Gen").password) == 24
    finally:
        vault.lock()


def test_get_masks_password_by_default_and_reveals_with_show(initialised, capsys):
    initialised("add", "Mail", "--username", "me", "--password", STRONG, stdin=[MASTER])
    capsys.readouterr()

    assert initialised("get", "Mail", stdin=[MASTER]) == 0
    assert STRONG not in capsys.readouterr().out

    assert initialised("get", "Mail", "--show", stdin=[MASTER]) == 0
    assert STRONG in capsys.readouterr().out


def test_get_is_case_insensitive_and_falls_back_to_search(initialised, capsys):
    initialised("add", "GitHub", "--username", "octocat", "--password", STRONG, stdin=[MASTER])
    capsys.readouterr()
    assert initialised("get", "github", "--show", stdin=[MASTER]) == 0
    assert STRONG in capsys.readouterr().out


def test_get_unknown_entry_fails(initialised):
    assert initialised("get", "nope", stdin=[MASTER]) != 0


def test_search_matches_metadata_but_not_passwords(initialised, capsys):
    initialised("add", "GitHub", "--username", "octocat", "--password", STRONG,
                "--url", "https://github.com", "--tags", "dev", stdin=[MASTER])
    initialised("add", "Bank", "--username", "customer", "--password", STRONG2, stdin=[MASTER])
    capsys.readouterr()

    assert initialised("search", "octo", stdin=[MASTER]) == 0
    out = capsys.readouterr().out
    assert "GitHub" in out and "Bank" not in out

    assert initialised("search", STRONG, stdin=[MASTER]) == 0
    assert "GitHub" not in capsys.readouterr().out


def test_list_filters_by_tag(initialised, capsys):
    initialised("add", "Work", "--password", STRONG, "--tags", "work", stdin=[MASTER])
    initialised("add", "Home", "--password", STRONG2, "--tags", "personal", stdin=[MASTER])
    capsys.readouterr()
    assert initialised("list", "--tag", "work", stdin=[MASTER]) == 0
    out = capsys.readouterr().out
    assert "Work" in out and "Home" not in out


def test_wrong_master_password_is_reported_without_detail(initialised, capsys):
    initialised("add", "X", "--password", STRONG, stdin=[MASTER])
    capsys.readouterr()
    assert initialised("list", stdin=["wrong-password"]) != 0
    assert "wrong master password or corrupted vault" in capsys.readouterr().err


# --- edit / remove ----------------------------------------------------------

def test_edit_updates_fields_and_bumps_timestamp(initialised):
    initialised("add", "Site", "--username", "old", "--password", STRONG, stdin=[MASTER])
    vault = Vault.open(initialised.path, MASTER)
    before = vault.data.find_by_title("Site").updated_at
    vault.lock()

    assert initialised("edit", "Site", "--username", "new", "--tags", "a,b", stdin=[MASTER]) == 0
    vault = Vault.open(initialised.path, MASTER)
    try:
        entry = vault.data.find_by_title("Site")
        assert entry.username == "new"
        assert entry.tags == ["a", "b"]
        assert entry.updated_at >= before
    finally:
        vault.lock()


def test_edit_regenerates_password(initialised):
    initialised("add", "Site", "--password", STRONG, stdin=[MASTER])
    assert initialised("edit", "Site", "--generate", "--length", "32", stdin=[MASTER]) == 0
    vault = Vault.open(initialised.path, MASTER)
    try:
        password = vault.data.find_by_title("Site").password
        assert password != STRONG and len(password) == 32
    finally:
        vault.lock()


def test_edit_rename(initialised):
    initialised("add", "Old", "--password", STRONG, stdin=[MASTER])
    assert initialised("edit", "Old", "--rename", "New", stdin=[MASTER]) == 0
    vault = Vault.open(initialised.path, MASTER)
    try:
        assert vault.data.find_by_title("New") is not None
        assert vault.data.find_by_title("Old") is None
    finally:
        vault.lock()


def test_remove_requires_confirmation(initialised):
    initialised("add", "Doomed", "--password", STRONG, stdin=[MASTER])
    assert initialised("remove", "Doomed", stdin=[MASTER]) != 0  # no --yes, non-interactive
    assert initialised("remove", "Doomed", "--yes", stdin=[MASTER]) == 0
    vault = Vault.open(initialised.path, MASTER)
    try:
        assert vault.data.find_by_title("Doomed") is None
    finally:
        vault.lock()


# --- gen --------------------------------------------------------------------

def test_gen_needs_no_vault(cli, capsys):
    assert cli("gen", "--length", "24") == 0
    lines = [l for l in capsys.readouterr().out.splitlines() if l.strip()]
    assert len(lines[0].strip()) == 24


def test_gen_count_and_passphrase(cli, capsys):
    assert cli("gen", "--count", "3", "--length", "16") == 0
    lines = [l for l in capsys.readouterr().out.splitlines() if l.strip()]
    assert len({l for l in lines[:3]}) == 3

    assert cli("gen", "--words", "5") == 0
    assert len(capsys.readouterr().out.splitlines()[0].split("-")) == 5


def test_gen_respects_exclusions(cli, capsys):
    assert cli("gen", "--length", "40", "--no-symbols", "--exclude-ambiguous") == 0
    password = capsys.readouterr().out.splitlines()[0].strip()
    assert password.isalnum()
    assert not (set(password) & set("0O1lI"))


def test_gen_reports_impossible_settings(cli):
    assert cli("gen", "--no-lower", "--no-upper", "--no-digits", "--no-symbols") != 0


# --- totp -------------------------------------------------------------------

def test_totp_generates_a_six_digit_code(initialised, capsys):
    initialised("add", "2FA", "--password", STRONG, "--totp", RFC_SECRET_B32, stdin=[MASTER])
    capsys.readouterr()
    assert initialised("totp", "2FA", stdin=[MASTER]) == 0
    out = capsys.readouterr().out
    code = out.split()[0]
    assert code.isdigit() and len(code) == 6


def test_totp_fails_without_a_secret(initialised):
    initialised("add", "NoTOTP", "--password", STRONG, stdin=[MASTER])
    assert initialised("totp", "NoTOTP", stdin=[MASTER]) != 0


def test_totp_secret_is_normalised_on_add(initialised):
    initialised("add", "2FA", "--password", STRONG, "--totp", "gezd gnbv gy3t qojq", stdin=[MASTER])
    vault = Vault.open(initialised.path, MASTER)
    try:
        assert vault.data.find_by_title("2FA").totp_secret == "GEZDGNBVGY3TQOJQ"
    finally:
        vault.lock()


# --- audit ------------------------------------------------------------------

def test_audit_reports_weak_and_reused(initialised, capsys):
    initialised("add", "Weak", "--password", "letmein", stdin=[MASTER])
    initialised("add", "A", "--password", "Sh4red!Passw0rd#xyz9", stdin=[MASTER])
    initialised("add", "B", "--password", "Sh4red!Passw0rd#xyz9", stdin=[MASTER])
    capsys.readouterr()

    assert initialised("audit", stdin=[MASTER]) == 0
    out = capsys.readouterr().out
    assert "weak" in out and "reused" in out
    assert "Weak" in out and "A" in out and "B" in out
    # The report names entries and problems, never the secret values.
    assert "letmein" not in out
    assert "Sh4red!Passw0rd#xyz9" not in out


def test_audit_strict_exits_non_zero(initialised):
    initialised("add", "Weak", "--password", "password", stdin=[MASTER])
    assert initialised("audit", "--strict", stdin=[MASTER]) != 0


def test_audit_clean_vault_exits_zero(initialised, capsys):
    initialised("add", "Good", "--password", "x9$Kq2!vLm8@Zp4wRt6#", stdin=[MASTER])
    capsys.readouterr()
    assert initialised("audit", stdin=[MASTER]) == 0
    assert "no problems found" in capsys.readouterr().out


# --- export / import --------------------------------------------------------

def test_encrypted_export_round_trip(initialised, tmp_path):
    initialised("add", "GitHub", "--username", "octocat", "--password", STRONG, stdin=[MASTER])
    dest = tmp_path / "backup.vault.json"

    assert initialised("export", str(dest), stdin=[MASTER]) == 0
    assert file_mode(dest) == 0o600
    assert STRONG.encode() not in dest.read_bytes()

    exported = Vault.open(dest, MASTER)
    try:
        assert exported.data.find_by_title("GitHub").password == STRONG
    finally:
        exported.lock()


def test_plaintext_export_requires_confirmation(initialised, tmp_path):
    initialised("add", "X", "--password", STRONG, stdin=[MASTER])
    dest = tmp_path / "leak.json"
    assert initialised("export", str(dest), "--plaintext", stdin=[MASTER]) != 0
    assert not dest.exists()


def test_plaintext_export_json_round_trips_through_import(initialised, tmp_path, capsys):
    initialised("add", "GitHub", "--username", "octocat", "--password", STRONG,
                "--url", "https://github.com", "--tags", "dev,work", stdin=[MASTER])
    initialised("add", "Mail", "--username", "me@example.com", "--password", STRONG2, stdin=[MASTER])

    dump = tmp_path / "export.json"
    assert initialised("export", str(dump), "--plaintext", "--yes", stdin=[MASTER]) == 0
    assert file_mode(dump) == 0o600
    payload = json.loads(dump.read_text())
    assert {e["title"] for e in payload["entries"]} == {"GitHub", "Mail"}

    # Import into a second, separate vault.
    second = tmp_path / "second.json"
    assert initialised("init", stdin=[OTHER_MASTER, OTHER_MASTER], vault=second) == 0
    assert initialised("import", str(dump), "--yes", stdin=[OTHER_MASTER], vault=second) == 0

    restored = Vault.open(second, OTHER_MASTER)
    try:
        github = restored.data.find_by_title("GitHub")
        assert github.password == STRONG
        assert github.username == "octocat"
        assert github.tags == ["dev", "work"]
        assert github.url == "https://github.com"
        assert restored.data.find_by_title("Mail").password == STRONG2
    finally:
        restored.lock()


def test_plaintext_export_csv_round_trips_through_import(initialised, tmp_path):
    initialised("add", "GitHub", "--username", "octocat", "--password", STRONG,
                "--tags", "dev,work", stdin=[MASTER])

    dump = tmp_path / "export.csv"
    assert initialised("export", str(dump), "--plaintext", "--format", "csv", "--yes", stdin=[MASTER]) == 0
    rows = list(csv.DictReader(dump.read_text().splitlines()))
    assert rows[0]["title"] == "GitHub" and rows[0]["tags"] == "dev,work"

    second = tmp_path / "second.json"
    initialised("init", stdin=[OTHER_MASTER, OTHER_MASTER], vault=second)
    assert initialised("import", str(dump), "--yes", stdin=[OTHER_MASTER], vault=second) == 0

    restored = Vault.open(second, OTHER_MASTER)
    try:
        entry = restored.data.find_by_title("GitHub")
        assert entry.password == STRONG
        assert entry.tags == ["dev", "work"]
    finally:
        restored.lock()


def test_import_accepts_foreign_column_names(initialised, tmp_path):
    source = tmp_path / "other-manager.csv"
    source.write_text("name,login,pass,website\nExample,alice,S3cr3t!Passw0rd#x,https://example.com\n")
    assert initialised("import", str(source), "--yes", stdin=[MASTER]) == 0

    vault = Vault.open(initialised.path, MASTER)
    try:
        entry = vault.data.find_by_title("Example")
        assert entry.username == "alice"
        assert entry.password == "S3cr3t!Passw0rd#x"
        assert entry.url == "https://example.com"
    finally:
        vault.lock()


def test_import_skips_duplicates_unless_overwrite(initialised, tmp_path):
    initialised("add", "Dup", "--password", STRONG, stdin=[MASTER])
    source = tmp_path / "in.json"
    source.write_text(json.dumps({"entries": [{"title": "Dup", "password": STRONG2}]}))

    assert initialised("import", str(source), "--yes", stdin=[MASTER]) == 0
    vault = Vault.open(initialised.path, MASTER)
    assert vault.data.find_by_title("Dup").password == STRONG
    vault.lock()

    assert initialised("import", str(source), "--yes", "--overwrite", stdin=[MASTER]) == 0
    vault = Vault.open(initialised.path, MASTER)
    try:
        assert vault.data.find_by_title("Dup").password == STRONG2
        assert len(vault.data.entries) == 1
    finally:
        vault.lock()


def test_import_requires_confirmation(initialised, tmp_path):
    source = tmp_path / "in.json"
    source.write_text(json.dumps({"entries": [{"title": "New", "password": STRONG}]}))
    assert initialised("import", str(source), stdin=[MASTER]) != 0
    vault = Vault.open(initialised.path, MASTER)
    try:
        assert vault.data.find_by_title("New") is None
    finally:
        vault.lock()


def test_import_warns_loudly_about_plaintext(initialised, tmp_path, capsys):
    source = tmp_path / "in.json"
    source.write_text(json.dumps({"entries": [{"title": "New", "password": STRONG}]}))
    initialised("import", str(source), "--yes", stdin=[MASTER])
    combined = capsys.readouterr()
    assert "PLAINTEXT" in combined.out
    assert "shred" in combined.err or "shred" in combined.out


def test_import_missing_file_fails(initialised, tmp_path):
    assert initialised("import", str(tmp_path / "absent.csv"), "--yes", stdin=[MASTER]) != 0


# --- change-master ----------------------------------------------------------

def test_change_master_password_end_to_end(initialised, capsys):
    initialised("add", "GitHub", "--username", "octocat", "--password", STRONG, stdin=[MASTER])
    capsys.readouterr()

    assert initialised("change-master", stdin=[MASTER, OTHER_MASTER, OTHER_MASTER]) == 0

    assert initialised("get", "GitHub", "--show", stdin=[MASTER]) != 0
    assert initialised("get", "GitHub", "--show", stdin=[OTHER_MASTER]) == 0
    assert STRONG in capsys.readouterr().out


def test_change_master_rejects_reuse_of_the_same_password(initialised):
    assert initialised("change-master", stdin=[MASTER, MASTER, MASTER]) != 0


def test_change_master_rejects_weak_new_password(initialised):
    assert initialised("change-master", stdin=[MASTER, "password", "password"]) != 0
    Vault.open(initialised.path, MASTER).lock()


def test_change_master_rejects_mismatched_confirmation(initialised):
    assert initialised("change-master", stdin=[MASTER, OTHER_MASTER, "typo"]) != 0
    Vault.open(initialised.path, MASTER).lock()


# --- storage guarantees through the CLI ------------------------------------

def test_vault_stays_0600_and_opaque_after_many_operations(initialised, tmp_path):
    initialised("add", "One", "--password", STRONG, stdin=[MASTER])
    initialised("add", "Two", "--password", STRONG2, stdin=[MASTER])
    initialised("edit", "One", "--username", "changed", stdin=[MASTER])
    initialised("remove", "Two", "--yes", stdin=[MASTER])

    assert file_mode(initialised.path) == 0o600
    raw = initialised.path.read_bytes()
    for secret in (STRONG.encode(), STRONG2.encode(), MASTER.encode(), b"changed"):
        assert secret not in raw

    backups = list_backups(initialised.path)
    assert 0 < len(backups) <= 5
    assert all(file_mode(b) == 0o600 for b in backups)


def test_no_command_prints_help(cli):
    assert cli() == 2


# --- rich markup must never be interpreted in user data ---------------------

MARKUP_PASSWORD = "pw[bold]12[/bold]!Zq7#"


def test_password_containing_markup_is_printed_verbatim(initialised, capsys):
    """A password with '[bold]' in it must not be swallowed by rich.

    The generator's alphabet includes '[' and ']', so this can happen by
    accident - and a silently mangled password is worse than no output.
    """
    initialised("add", "Markup", "--password", MARKUP_PASSWORD, stdin=[MASTER])
    capsys.readouterr()

    assert initialised("get", "Markup", "--password-only", "--show", stdin=[MASTER]) == 0
    assert capsys.readouterr().out.strip() == MARKUP_PASSWORD


def test_entry_fields_containing_markup_render_literally(initialised, capsys):
    initialised("add", "Site[bold]X", "--username", "a[red]b",
                "--password", MARKUP_PASSWORD, "--notes", "note [i]x", stdin=[MASTER])
    capsys.readouterr()

    assert initialised("get", "Site[bold]X", "--show", stdin=[MASTER]) == 0
    out = capsys.readouterr().out
    assert "Site[bold]X" in out
    assert "a[red]b" in out
    assert "note [i]x" in out


def test_unclosed_markup_in_a_title_does_not_crash(initialised, capsys):
    """An unterminated tag would raise MarkupError if it were parsed."""
    assert initialised("get", "no[such", stdin=[MASTER]) != 0
    assert "no[such" in capsys.readouterr().err


def test_markup_in_titles_survives_list_and_audit(initialised, capsys):
    initialised("add", "W[b]k", "--password", "letmein", stdin=[MASTER])
    capsys.readouterr()

    assert initialised("list", stdin=[MASTER]) == 0
    assert "W[b]k" in capsys.readouterr().out

    assert initialised("audit", stdin=[MASTER]) == 0
    assert "W[b]k" in capsys.readouterr().out


def test_generated_passwords_are_printed_verbatim(cli, capsys):
    """gen output must be copy-pasteable even when it contains brackets."""
    for _ in range(30):
        assert cli("gen", "--length", "24") == 0
        printed = capsys.readouterr().out.splitlines()[0].strip()
        assert len(printed) == 24, f"rich mangled {printed!r}"
