"""Cryptographic primitives for the vault.

Design
------
* Key derivation: Argon2id (time_cost=3, memory_cost=64 MiB, parallelism=4,
  32-byte output) over a random 16-byte salt held in the vault header.
* Body encryption: AES-256-GCM with a fresh random 12-byte nonce per write.
* The serialised vault header (version + KDF params + salt) is passed to
  AES-GCM as Additional Authenticated Data, so header tampering breaks
  decryption instead of silently downgrading parameters.
* Key material lives in ``bytearray`` and is zeroised explicitly where the
  Python runtime allows it.

Nothing in this module ever writes to disk or logs.
"""

from __future__ import annotations

import hmac
import json
import os
import secrets
from dataclasses import dataclass, asdict
from typing import Any, Dict

from argon2.low_level import Type as Argon2Type, hash_secret_raw
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# --- Tunable-but-pinned KDF parameters -------------------------------------
ARGON2_TIME_COST = 3
ARGON2_MEMORY_COST_KIB = 64 * 1024  # 64 MiB, argon2 takes KiB
ARGON2_PARALLELISM = 4
KEY_LEN = 32  # AES-256
SALT_LEN = 16
NONCE_LEN = 12  # GCM standard nonce size

KDF_NAME = "argon2id"
CIPHER_NAME = "aes-256-gcm"


class CryptoError(Exception):
    """Base class for cryptographic failures."""


class DecryptionError(CryptoError):
    """Raised when the vault cannot be decrypted or authenticated.

    Deliberately does not distinguish a wrong password from a corrupt or
    tampered vault: both fail identically so an attacker learns nothing.
    """

    MESSAGE = "wrong master password or corrupted vault"

    def __init__(self, message: str = MESSAGE) -> None:
        super().__init__(message)


@dataclass(frozen=True)
class KdfParams:
    """Argon2id parameters, serialised into the vault header."""

    name: str = KDF_NAME
    time_cost: int = ARGON2_TIME_COST
    memory_cost: int = ARGON2_MEMORY_COST_KIB
    parallelism: int = ARGON2_PARALLELISM
    key_len: int = KEY_LEN

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "KdfParams":
        if data.get("name") != KDF_NAME:
            raise CryptoError(f"unsupported KDF: {data.get('name')!r}")
        try:
            return cls(
                name=str(data["name"]),
                time_cost=int(data["time_cost"]),
                memory_cost=int(data["memory_cost"]),
                parallelism=int(data["parallelism"]),
                key_len=int(data["key_len"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise CryptoError("malformed KDF parameters in vault header") from exc


def generate_salt() -> bytes:
    """A fresh 16-byte KDF salt from the OS CSPRNG."""
    return secrets.token_bytes(SALT_LEN)


def generate_nonce() -> bytes:
    """A fresh 12-byte AES-GCM nonce from the OS CSPRNG."""
    return secrets.token_bytes(NONCE_LEN)


def derive_key(master_password: str, salt: bytes, params: KdfParams | None = None) -> bytearray:
    """Derive the 32-byte vault key from the master password.

    Returns a ``bytearray`` so the caller can zeroise it via :func:`wipe`.
    The password is encoded to a temporary buffer that is also wiped.
    """
    params = params or KdfParams()
    if len(salt) != SALT_LEN:
        raise CryptoError(f"salt must be {SALT_LEN} bytes, got {len(salt)}")

    secret = bytearray(master_password.encode("utf-8"))
    try:
        raw = hash_secret_raw(
            secret=bytes(secret),
            salt=salt,
            time_cost=params.time_cost,
            memory_cost=params.memory_cost,
            parallelism=params.parallelism,
            hash_len=params.key_len,
            type=Argon2Type.ID,
        )
    finally:
        wipe(secret)
    return bytearray(raw)


def encrypt(key: bytes | bytearray, plaintext: bytes, aad: bytes) -> tuple[bytes, bytes]:
    """AES-256-GCM encrypt ``plaintext``, binding ``aad``.

    Returns ``(nonce, ciphertext_with_tag)``.
    """
    if len(key) != KEY_LEN:
        raise CryptoError(f"key must be {KEY_LEN} bytes, got {len(key)}")
    nonce = generate_nonce()
    aesgcm = AESGCM(bytes(key))
    ciphertext = aesgcm.encrypt(nonce, plaintext, aad)
    return nonce, ciphertext


def decrypt(key: bytes | bytearray, nonce: bytes, ciphertext: bytes, aad: bytes) -> bytes:
    """AES-256-GCM decrypt and authenticate. Fails closed.

    Any failure - wrong key, tampered ciphertext, tampered AAD/header,
    truncated data - raises :class:`DecryptionError` with one message.
    """
    if len(key) != KEY_LEN:
        raise DecryptionError()
    if len(nonce) != NONCE_LEN:
        raise DecryptionError()
    try:
        aesgcm = AESGCM(bytes(key))
        return aesgcm.decrypt(nonce, ciphertext, aad)
    except (InvalidTag, ValueError):
        raise DecryptionError() from None


def header_aad(header: Dict[str, Any]) -> bytes:
    """Canonical serialisation of the header for use as AES-GCM AAD.

    Sorted keys and no insignificant whitespace, so the byte string depends
    only on header *content*, not on dict ordering or file formatting.
    """
    return json.dumps(header, sort_keys=True, separators=(",", ":")).encode("utf-8")


def constant_time_equal(a: bytes | bytearray | str, b: bytes | bytearray | str) -> bool:
    """Timing-safe equality for secrets."""
    if isinstance(a, str):
        a = a.encode("utf-8")
    if isinstance(b, str):
        b = b.encode("utf-8")
    return hmac.compare_digest(bytes(a), bytes(b))


def wipe(buf: bytearray | None) -> None:
    """Best-effort zeroisation of a mutable buffer.

    CPython cannot guarantee no copy of the secret survives (immutable
    ``bytes``/``str`` interning, GC moves, swap), but zeroing the buffer we
    control shortens the window meaningfully. See SECURITY.md.
    """
    if not buf:
        return
    try:
        for i in range(len(buf)):
            buf[i] = 0
    except TypeError:  # not a mutable buffer; nothing we can do
        pass


def random_token_bytes(n: int) -> bytes:
    """CSPRNG bytes, exposed so callers never reach for ``random``."""
    return secrets.token_bytes(n)


def urandom_available() -> bool:
    """Sanity check that an OS CSPRNG is present."""
    try:
        os.urandom(1)
        return True
    except NotImplementedError:  # pragma: no cover
        return False
