"""Shared pytest fixtures and helpers."""

from __future__ import annotations

import io
import sys
from pathlib import Path
from typing import List, Optional, Sequence

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pwmgr.models import Entry  # noqa: E402
from pwmgr.vault import Vault  # noqa: E402

MASTER = "correct-horse-battery-staple-9"
OTHER_MASTER = "another-master-passphrase-77"

# RFC 4226 / RFC 6238 shared secret, base32 of "12345678901234567890".
RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"


@pytest.fixture
def vault_path(tmp_path: Path) -> Path:
    """Path to a vault inside an isolated temp directory."""
    return tmp_path / "vault.json"


@pytest.fixture
def new_vault(vault_path: Path) -> Vault:
    """A freshly created, unlocked, empty vault."""
    vault = Vault.create(vault_path, MASTER)
    yield vault
    vault.lock()


@pytest.fixture
def populated_vault(new_vault: Vault) -> Vault:
    """A vault with three representative entries saved to disk."""
    new_vault.data.add(Entry(
        title="GitHub",
        username="octocat",
        password="J8#pQ2!vLm4@Zx7wRt6z",
        url="https://github.com",
        tags=["dev", "work"],
        totp_secret=RFC_SECRET_B32,
    ))
    new_vault.data.add(Entry(
        title="Email",
        username="me@example.com",
        password="Kd9$Wq3&Nb6^Yh1*Uj5r",
        url="https://mail.example.com",
        tags=["personal"],
    ))
    new_vault.data.add(Entry(
        title="Router",
        username="admin",
        password="password",  # deliberately terrible, for the audit tests
        url="http://192.168.1.1",
        tags=["home"],
    ))
    new_vault.save()
    return new_vault


def run_cli(
    argv: Sequence[str],
    monkeypatch: pytest.MonkeyPatch,
    stdin_lines: Optional[List[str]] = None,
) -> int:
    """Invoke the CLI with a scripted stdin, returning its exit code."""
    from pwmgr import cli

    payload = "".join(line + "\n" for line in (stdin_lines or []))
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload))
    return cli.main(list(argv))
