"""TOTP/HOTP tests, anchored on the published RFC test vectors."""

from __future__ import annotations

import base64
import time

import pytest

from pwmgr.totp import (
    DEFAULT_PERIOD,
    TOTPError,
    decode_secret,
    hotp,
    normalise_secret,
    parse_otpauth_uri,
    random_secret,
    seconds_remaining,
    totp,
    verify,
)

# RFC 4226 Appendix D / RFC 6238 Appendix B seeds.
SEED_SHA1 = b"12345678901234567890"
SEED_SHA256 = b"12345678901234567890123456789012"
SEED_SHA512 = b"1234567890123456789012345678901234567890123456789012345678901234"


def b32(raw: bytes) -> str:
    return base64.b32encode(raw).decode("ascii")


# --- RFC 4226 (HOTP) --------------------------------------------------------

RFC4226_VECTORS = [
    (0, "755224"), (1, "287082"), (2, "359152"), (3, "969429"), (4, "338314"),
    (5, "254676"), (6, "287922"), (7, "162583"), (8, "399871"), (9, "520489"),
]


@pytest.mark.parametrize("counter,expected", RFC4226_VECTORS)
def test_rfc4226_hotp_vectors(counter, expected):
    assert hotp(SEED_SHA1, counter) == expected


def test_hotp_rejects_negative_counter():
    with pytest.raises(TOTPError):
        hotp(SEED_SHA1, -1)


@pytest.mark.parametrize("digits", [5, 11])
def test_hotp_rejects_out_of_range_digit_counts(digits):
    with pytest.raises(TOTPError):
        hotp(SEED_SHA1, 0, digits=digits)


def test_hotp_rejects_unknown_algorithm():
    with pytest.raises(TOTPError, match="unsupported algorithm"):
        hotp(SEED_SHA1, 0, algorithm="md5")


# --- RFC 6238 (TOTP) --------------------------------------------------------

RFC6238_TIMES = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000]

RFC6238_SHA1 = ["94287082", "07081804", "14050471", "89005924", "69279037", "65353130"]
RFC6238_SHA256 = ["46119246", "68084774", "67062674", "91819424", "90698825", "77737706"]
RFC6238_SHA512 = ["90693936", "25091201", "99943326", "93441116", "38618901", "47863826"]


@pytest.mark.parametrize("timestamp,expected", list(zip(RFC6238_TIMES, RFC6238_SHA1)))
def test_rfc6238_sha1_vectors(timestamp, expected):
    assert totp(b32(SEED_SHA1), timestamp=timestamp, digits=8, algorithm="SHA1") == expected


@pytest.mark.parametrize("timestamp,expected", list(zip(RFC6238_TIMES, RFC6238_SHA256)))
def test_rfc6238_sha256_vectors(timestamp, expected):
    assert totp(b32(SEED_SHA256), timestamp=timestamp, digits=8, algorithm="SHA256") == expected


@pytest.mark.parametrize("timestamp,expected", list(zip(RFC6238_TIMES, RFC6238_SHA512)))
def test_rfc6238_sha512_vectors(timestamp, expected):
    assert totp(b32(SEED_SHA512), timestamp=timestamp, digits=8, algorithm="SHA512") == expected


def test_six_digit_codes_are_the_last_six_of_the_eight_digit_vector():
    """The 6-digit default is the same truncation, mod 10^6."""
    for timestamp, expected8 in zip(RFC6238_TIMES, RFC6238_SHA1):
        assert totp(b32(SEED_SHA1), timestamp=timestamp, digits=6) == expected8[-6:]


def test_code_is_stable_within_a_time_step_and_changes_across_steps():
    secret = b32(SEED_SHA1)
    base = 1234567890 - (1234567890 % DEFAULT_PERIOD)
    assert totp(secret, timestamp=base) == totp(secret, timestamp=base + DEFAULT_PERIOD - 1)
    assert totp(secret, timestamp=base) != totp(secret, timestamp=base + DEFAULT_PERIOD)


def test_custom_period_changes_the_code():
    secret = b32(SEED_SHA1)
    assert totp(secret, timestamp=59, period=60) != totp(secret, timestamp=59, period=30)


def test_zero_or_negative_period_is_rejected():
    with pytest.raises(TOTPError):
        totp(b32(SEED_SHA1), timestamp=59, period=0)


def test_totp_defaults_to_now():
    secret = b32(SEED_SHA1)
    assert totp(secret) == totp(secret, timestamp=time.time())


# --- seconds remaining ------------------------------------------------------

@pytest.mark.parametrize("timestamp,expected", [(0, 30), (1, 29), (29, 1), (30, 30), (45, 15)])
def test_seconds_remaining(timestamp, expected):
    assert seconds_remaining(timestamp) == expected


# --- secret handling --------------------------------------------------------

def test_normalise_secret_handles_spacing_case_and_padding():
    assert normalise_secret("gezd gnbv gy3t qojq") == "GEZDGNBVGY3TQOJQ"
    assert normalise_secret("GEZD-GNBV-GY3T-QOJQ") == "GEZDGNBVGY3TQOJQ"
    assert normalise_secret("GEZDGNBVGY3TQOJQ====") == "GEZDGNBVGY3TQOJQ"


def test_untidy_secret_produces_the_same_code_as_the_clean_one():
    clean = b32(SEED_SHA1)
    untidy = " ".join(clean[i:i + 4] for i in range(0, len(clean), 4)).lower()
    assert totp(untidy, timestamp=59, digits=8) == "94287082"


def test_decode_secret_matches_the_raw_seed():
    assert decode_secret(b32(SEED_SHA1)) == SEED_SHA1


@pytest.mark.parametrize("bad", ["", "not-base32!", "8189", "abc$%^"])
def test_invalid_secrets_are_rejected(bad):
    with pytest.raises(TOTPError):
        decode_secret(bad)


def test_random_secret_is_valid_and_unique():
    secrets_seen = {random_secret() for _ in range(50)}
    assert len(secrets_seen) == 50
    for value in secrets_seen:
        assert len(decode_secret(value)) == 20
        assert len(totp(value)) == 6


# --- verification -----------------------------------------------------------

def test_verify_accepts_the_current_code():
    secret = b32(SEED_SHA1)
    assert verify(secret, totp(secret, timestamp=1234567890), timestamp=1234567890)


def test_verify_accepts_adjacent_steps_within_the_window():
    secret = b32(SEED_SHA1)
    now = 1234567890
    for drift in (-DEFAULT_PERIOD, 0, DEFAULT_PERIOD):
        assert verify(secret, totp(secret, timestamp=now + drift), timestamp=now, window=1)


def test_verify_rejects_codes_outside_the_window():
    secret = b32(SEED_SHA1)
    now = 1234567890
    assert not verify(secret, totp(secret, timestamp=now + 5 * DEFAULT_PERIOD), timestamp=now, window=1)


@pytest.mark.parametrize("bad", ["000000", "", "abcdef", "1234567"])
def test_verify_rejects_wrong_codes(bad):
    assert not verify(b32(SEED_SHA1), bad, timestamp=1234567890)


# --- otpauth URIs -----------------------------------------------------------

def test_parse_otpauth_uri():
    uri = (
        "otpauth://totp/Example:alice@example.com"
        f"?secret={b32(SEED_SHA1)}&issuer=Example&digits=8&period=60&algorithm=SHA256"
    )
    parsed = parse_otpauth_uri(uri)
    assert parsed["secret"] == b32(SEED_SHA1)
    assert parsed["issuer"] == "Example"
    assert parsed["digits"] == 8
    assert parsed["period"] == 60
    assert parsed["algorithm"] == "SHA256"
    assert parsed["label"] == "Example:alice@example.com"


def test_parse_otpauth_uri_defaults():
    parsed = parse_otpauth_uri(f"otpauth://totp/Test?secret={b32(SEED_SHA1)}")
    assert parsed["digits"] == 6 and parsed["period"] == 30 and parsed["algorithm"] == "SHA1"


@pytest.mark.parametrize("uri", [
    "https://example.com",
    "otpauth://hotp/Test?secret=GEZDGNBVGY3TQOJQ",
    "otpauth://totp/Test",
])
def test_parse_otpauth_uri_rejects_bad_input(uri):
    with pytest.raises(TOTPError):
        parse_otpauth_uri(uri)
