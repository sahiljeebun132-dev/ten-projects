"""Vault file format, atomic persistence, backup rotation and session state.

File format (UTF-8 JSON, one object)::

    {
      "header": {
        "format": "pwmgr-vault",
        "version": 1,
        "kdf": {"name": "argon2id", "time_cost": 3, ...},
        "salt": "<base64>",
        "cipher": "aes-256-gcm",
        "created_at": "..."
      },
      "nonce": "<base64>",
      "ciphertext": "<base64 of AES-GCM output incl. 16-byte tag>"
    }

The canonical serialisation of ``header`` is the AES-GCM AAD, so any edit to
the version, KDF parameters or salt makes the body fail authentication.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import VAULT_FORMAT_VERSION
from .crypto import (
    CryptoError,
    DecryptionError,
    KdfParams,
    decrypt,
    derive_key,
    encrypt,
    generate_salt,
    header_aad,
    wipe,
)
from .models import VaultData, utcnow_iso

FORMAT_MAGIC = "pwmgr-vault"
VAULT_MODE = 0o600
DIR_MODE = 0o700
BACKUP_KEEP = 5
DEFAULT_VAULT_PATH = Path.home() / ".pwmgr" / "vault.json"
DEFAULT_AUTOLOCK_MINUTES = 5


class VaultError(Exception):
    """Vault-level failure (missing file, bad format, etc.)."""


def _b64e(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _b64d(text: str) -> bytes:
    try:
        return base64.b64decode(text.encode("ascii"), validate=True)
    except Exception as exc:  # noqa: BLE001 - any b64 failure is a bad vault
        raise VaultError("vault file is not valid base64") from exc


def vault_path_from(path: str | os.PathLike[str] | None) -> Path:
    """Resolve the vault path, honouring $PWMGR_VAULT then the default."""
    if path:
        return Path(path).expanduser()
    env = os.environ.get("PWMGR_VAULT")
    if env:
        return Path(env).expanduser()
    return DEFAULT_VAULT_PATH


def build_header(salt: bytes, params: KdfParams, created_at: Optional[str] = None) -> Dict[str, Any]:
    """Assemble the authenticated (but unencrypted) vault header."""
    return {
        "format": FORMAT_MAGIC,
        "version": VAULT_FORMAT_VERSION,
        "kdf": params.to_dict(),
        "salt": _b64e(salt),
        "cipher": "aes-256-gcm",
        "created_at": created_at or utcnow_iso(),
    }


# --- atomic write + backups -------------------------------------------------

def _backup_dir(path: Path) -> Path:
    return path.parent / "backups"


def make_backup(path: Path, keep: int = BACKUP_KEEP) -> Optional[Path]:
    """Copy the current vault to a timestamped backup, then rotate.

    Returns the backup path, or None if there was no vault to back up.
    Backups are copies of *ciphertext* and carry the same 0600 mode.
    """
    if not path.exists():
        return None
    bdir = _backup_dir(path)
    bdir.mkdir(parents=True, exist_ok=True)
    os.chmod(bdir, DIR_MODE)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    dest = bdir / f"{path.name}.{stamp}.bak"
    shutil.copy2(path, dest)
    os.chmod(dest, VAULT_MODE)
    rotate_backups(path, keep=keep)
    return dest


def list_backups(path: Path) -> List[Path]:
    """Existing backups for this vault, newest first."""
    bdir = _backup_dir(path)
    if not bdir.is_dir():
        return []
    found = [p for p in bdir.iterdir() if p.name.startswith(path.name + ".") and p.suffix == ".bak"]
    return sorted(found, key=lambda p: p.name, reverse=True)


def rotate_backups(path: Path, keep: int = BACKUP_KEEP) -> None:
    """Delete all but the ``keep`` newest backups."""
    for stale in list_backups(path)[keep:]:
        try:
            stale.unlink()
        except OSError:  # pragma: no cover - best effort
            pass


def atomic_write(path: Path, payload: bytes, mode: int = VAULT_MODE) -> None:
    """Write ``payload`` to ``path`` atomically with restrictive permissions.

    Writes to a temp file in the same directory (so ``os.replace`` stays on
    one filesystem and is therefore atomic), fsyncs it, chmods it *before*
    it becomes visible under the real name, then replaces. The directory is
    fsynced too so the rename survives a crash.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, DIR_MODE)
    except OSError:  # pragma: no cover - e.g. shared dir we do not own
        pass

    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    finally:
        try:
            dir_fd = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:  # pragma: no cover - not all platforms allow this
            pass


def file_mode(path: Path) -> int:
    """Permission bits of ``path`` (e.g. 0o600)."""
    return stat.S_IMODE(path.stat().st_mode)


# --- serialise / deserialise ------------------------------------------------

def serialise(data: VaultData, key: bytes | bytearray, header: Dict[str, Any]) -> bytes:
    """Encrypt ``data`` under ``key`` and render the on-disk JSON document."""
    body = json.dumps(data.to_dict(), separators=(",", ":")).encode("utf-8")
    plaintext = bytearray(body)
    try:
        nonce, ciphertext = encrypt(key, bytes(plaintext), header_aad(header))
    finally:
        wipe(plaintext)
    document = {
        "header": header,
        "nonce": _b64e(nonce),
        "ciphertext": _b64e(ciphertext),
    }
    return json.dumps(document, indent=2).encode("utf-8")


def read_document(path: Path) -> Dict[str, Any]:
    """Load and structurally validate the on-disk vault document."""
    if not path.exists():
        raise VaultError(f"no vault at {path} - run 'pwmgr init' first")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise VaultError(f"{path} is not a readable vault file") from exc
    if not isinstance(document, dict) or "header" not in document:
        raise VaultError(f"{path} is not a pwmgr vault")

    header = document["header"]
    if not isinstance(header, dict) or header.get("format") != FORMAT_MAGIC:
        raise VaultError(f"{path} is not a pwmgr vault")
    version = header.get("version")
    if version != VAULT_FORMAT_VERSION:
        raise VaultError(
            f"vault format version {version!r} is not supported by this build "
            f"(expected {VAULT_FORMAT_VERSION})"
        )
    for key in ("nonce", "ciphertext"):
        if not isinstance(document.get(key), str):
            raise VaultError(f"{path} is missing its {key}")
    return document


def unlock_document(document: Dict[str, Any], master_password: str) -> tuple[VaultData, bytearray]:
    """Derive the key and decrypt the body. Returns ``(data, key)``.

    The caller owns the returned key buffer and must :func:`wipe` it.
    """
    header = document["header"]
    try:
        params = KdfParams.from_dict(header.get("kdf", {}))
    except CryptoError as exc:
        raise VaultError(str(exc)) from exc

    salt = _b64d(header["salt"]) if isinstance(header.get("salt"), str) else b""
    key = derive_key(master_password, salt, params)
    try:
        plaintext = decrypt(
            key,
            _b64d(document["nonce"]),
            _b64d(document["ciphertext"]),
            header_aad(header),
        )
    except DecryptionError:
        wipe(key)
        raise
    except Exception:
        wipe(key)
        raise

    try:
        data = VaultData.from_dict(json.loads(plaintext.decode("utf-8")))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        wipe(key)
        # Authentication passed but the body is not valid JSON: still a
        # corrupted vault, and we keep the same opaque message.
        raise DecryptionError() from exc
    return data, key


# --- the session object -----------------------------------------------------

class Vault:
    """An unlocked vault session.

    Holds the derived key in a ``bytearray`` and tracks activity so the CLI
    can auto-lock. Use as a context manager to guarantee the key is wiped::

        with Vault.open(path, password) as vault:
            ...
    """

    def __init__(
        self,
        path: Path,
        data: VaultData,
        key: bytearray,
        header: Dict[str, Any],
        autolock_minutes: float = DEFAULT_AUTOLOCK_MINUTES,
    ) -> None:
        self.path = path
        self.data = data
        self._key: Optional[bytearray] = key
        self.header = header
        self.autolock_minutes = autolock_minutes
        self._last_activity = _monotonic()

    # -- construction --
    @classmethod
    def create(
        cls,
        path: str | os.PathLike[str],
        master_password: str,
        autolock_minutes: float = DEFAULT_AUTOLOCK_MINUTES,
        overwrite: bool = False,
    ) -> "Vault":
        """Initialise a brand new vault file."""
        path = Path(path).expanduser()
        if path.exists() and not overwrite:
            raise VaultError(f"a vault already exists at {path}")
        params = KdfParams()
        salt = generate_salt()
        header = build_header(salt, params)
        key = derive_key(master_password, salt, params)
        vault = cls(path, VaultData(), key, header, autolock_minutes)
        vault.save(backup=False)
        return vault

    @classmethod
    def open(
        cls,
        path: str | os.PathLike[str],
        master_password: str,
        autolock_minutes: float = DEFAULT_AUTOLOCK_MINUTES,
    ) -> "Vault":
        """Open and decrypt an existing vault."""
        path = Path(path).expanduser()
        document = read_document(path)
        data, key = unlock_document(document, master_password)
        return cls(path, data, key, document["header"], autolock_minutes)

    # -- key handling --
    @property
    def is_locked(self) -> bool:
        return self._key is None

    @property
    def key(self) -> bytearray:
        if self._key is None:
            raise VaultError("vault is locked")
        return self._key

    def lock(self) -> None:
        """Zeroise the key and drop decrypted entries from memory."""
        wipe(self._key)
        self._key = None
        self.data = VaultData()

    def touch(self) -> None:
        """Record activity, resetting the auto-lock countdown."""
        self._last_activity = _monotonic()

    def idle_seconds(self) -> float:
        return _monotonic() - self._last_activity

    def should_autolock(self) -> bool:
        if self.autolock_minutes <= 0:
            return False
        return self.idle_seconds() >= self.autolock_minutes * 60

    def check_autolock(self) -> bool:
        """Lock if idle past the threshold. Returns True if it locked now."""
        if not self.is_locked and self.should_autolock():
            self.lock()
            return True
        return False

    # -- persistence --
    def save(self, backup: bool = True, keep: int = BACKUP_KEEP) -> None:
        """Encrypt and atomically persist, backing up the previous file."""
        if self.is_locked:
            raise VaultError("cannot save a locked vault")
        self.data.updated_at = utcnow_iso()
        payload = serialise(self.data, self.key, self.header)
        if backup:
            make_backup(self.path, keep=keep)
        atomic_write(self.path, payload)
        self.touch()

    def change_master_password(self, new_password: str) -> None:
        """Re-derive the key with a fresh salt and re-encrypt everything."""
        if self.is_locked:
            raise VaultError("vault is locked")
        params = KdfParams()
        salt = generate_salt()
        new_header = build_header(salt, params, created_at=self.header.get("created_at"))
        new_key = derive_key(new_password, salt, params)
        old_key = self._key
        self._key = new_key
        self.header = new_header
        try:
            self.save()
        except BaseException:
            # Roll the session back so an in-memory vault is never left
            # holding a key that does not match what is on disk.
            wipe(new_key)
            self._key = old_key
            raise
        wipe(old_key)

    def export_encrypted(self, dest: str | os.PathLike[str]) -> Path:
        """Write a standalone encrypted copy (same key, fresh nonce)."""
        if self.is_locked:
            raise VaultError("vault is locked")
        dest = Path(dest).expanduser()
        atomic_write(dest, serialise(self.data, self.key, self.header))
        return dest

    # -- context manager --
    def __enter__(self) -> "Vault":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.lock()


def _monotonic() -> float:
    import time

    return time.monotonic()
