"""HOTP (RFC 4226) and TOTP (RFC 6238), implemented with hmac/hashlib.

No third-party OTP library is used, so the implementation can be read and
checked against the RFC test vectors directly (see tests/test_totp.py).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import struct
import time
from typing import Optional
from urllib.parse import parse_qs, unquote, urlparse

DEFAULT_DIGITS = 6
DEFAULT_PERIOD = 30
DEFAULT_ALGORITHM = "SHA1"

_ALGORITHMS = {
    "SHA1": hashlib.sha1,
    "SHA256": hashlib.sha256,
    "SHA512": hashlib.sha512,
}


class TOTPError(Exception):
    """Raised for malformed secrets or unsupported parameters."""


def normalise_secret(secret: str) -> str:
    """Upper-case, strip spaces/hyphens and re-pad a base32 secret.

    Authenticator apps show secrets in lower case, in groups of four, and
    often without padding; all of those should just work.
    """
    if not secret:
        raise TOTPError("empty TOTP secret")
    cleaned = re.sub(r"[\s\-]", "", secret).upper()
    if not re.fullmatch(r"[A-Z2-7]+=*", cleaned):
        raise TOTPError("TOTP secret is not valid base32")
    cleaned = cleaned.rstrip("=")
    padding = (-len(cleaned)) % 8
    return cleaned + "=" * padding


def decode_secret(secret: str) -> bytes:
    """Base32-decode a (possibly untidy) TOTP secret into raw key bytes."""
    try:
        raw = base64.b32decode(normalise_secret(secret), casefold=True)
    except (ValueError, TypeError) as exc:
        raise TOTPError("TOTP secret is not valid base32") from exc
    if not raw:
        raise TOTPError("TOTP secret decodes to zero bytes")
    return raw


def hotp(key: bytes, counter: int, digits: int = DEFAULT_DIGITS, algorithm: str = DEFAULT_ALGORITHM) -> str:
    """RFC 4226 HOTP.

    ``key`` is the raw (already base32-decoded) shared secret.
    """
    if counter < 0:
        raise TOTPError("HOTP counter must not be negative")
    if not 6 <= digits <= 10:
        raise TOTPError("digits must be between 6 and 10")
    digestmod = _ALGORITHMS.get(algorithm.upper())
    if digestmod is None:
        raise TOTPError(f"unsupported algorithm {algorithm!r}")

    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, digestmod).digest()

    # Dynamic truncation (RFC 4226 section 5.4)
    offset = digest[-1] & 0x0F
    chunk = digest[offset : offset + 4]
    code = struct.unpack(">I", chunk)[0] & 0x7FFFFFFF
    return str(code % (10 ** digits)).zfill(digits)


def totp(
    secret: str,
    timestamp: Optional[float] = None,
    digits: int = DEFAULT_DIGITS,
    period: int = DEFAULT_PERIOD,
    algorithm: str = DEFAULT_ALGORITHM,
    t0: int = 0,
) -> str:
    """RFC 6238 TOTP code for ``secret`` at ``timestamp`` (default: now)."""
    if period <= 0:
        raise TOTPError("period must be positive")
    now = time.time() if timestamp is None else timestamp
    counter = int((now - t0) // period)
    return hotp(decode_secret(secret), counter, digits=digits, algorithm=algorithm)


def seconds_remaining(timestamp: Optional[float] = None, period: int = DEFAULT_PERIOD) -> int:
    """Seconds until the current TOTP step rolls over."""
    if period <= 0:
        raise TOTPError("period must be positive")
    now = time.time() if timestamp is None else timestamp
    return int(period - (now % period))


def verify(
    secret: str,
    code: str,
    timestamp: Optional[float] = None,
    digits: int = DEFAULT_DIGITS,
    period: int = DEFAULT_PERIOD,
    algorithm: str = DEFAULT_ALGORITHM,
    window: int = 1,
) -> bool:
    """Constant-time check of ``code`` across +/- ``window`` time steps."""
    now = time.time() if timestamp is None else timestamp
    candidate = (code or "").strip()
    ok = False
    for drift in range(-window, window + 1):
        expected = totp(
            secret,
            timestamp=now + drift * period,
            digits=digits,
            period=period,
            algorithm=algorithm,
        )
        # Do not break early: compare against every step so the runtime does
        # not leak which step matched.
        if hmac.compare_digest(expected, candidate):
            ok = True
    return ok


def random_secret(length_bytes: int = 20) -> str:
    """Generate a fresh base32 TOTP secret (default 160 bits, RFC 4226)."""
    import secrets as _secrets

    return base64.b32encode(_secrets.token_bytes(length_bytes)).decode("ascii").rstrip("=")


def parse_otpauth_uri(uri: str) -> dict:
    """Extract secret/digits/period/algorithm from an ``otpauth://`` URI."""
    parsed = urlparse(uri)
    if parsed.scheme != "otpauth":
        raise TOTPError("not an otpauth:// URI")
    if parsed.netloc.lower() != "totp":
        raise TOTPError(f"unsupported OTP type {parsed.netloc!r} (only totp)")
    query = parse_qs(parsed.query)
    secret = (query.get("secret") or [""])[0]
    if not secret:
        raise TOTPError("otpauth URI has no secret")
    label = unquote(parsed.path.lstrip("/"))
    return {
        "label": label,
        "issuer": (query.get("issuer") or [""])[0],
        "secret": normalise_secret(secret),
        "digits": int((query.get("digits") or [DEFAULT_DIGITS])[0]),
        "period": int((query.get("period") or [DEFAULT_PERIOD])[0]),
        "algorithm": (query.get("algorithm") or [DEFAULT_ALGORITHM])[0].upper(),
    }
