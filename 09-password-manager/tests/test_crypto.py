"""Tests for key derivation and authenticated encryption."""

from __future__ import annotations

import json

import pytest

from pwmgr.crypto import (
    KEY_LEN,
    NONCE_LEN,
    SALT_LEN,
    DecryptionError,
    KdfParams,
    constant_time_equal,
    decrypt,
    derive_key,
    encrypt,
    generate_nonce,
    generate_salt,
    header_aad,
    wipe,
)

PLAINTEXT = b'{"entries":[{"title":"GitHub","password":"s3cr3t"}]}'
HEADER = {"format": "pwmgr-vault", "version": 1, "salt": "AAAA", "kdf": {"name": "argon2id"}}


def test_derive_key_length_and_type():
    key = derive_key("master", generate_salt())
    assert isinstance(key, bytearray)
    assert len(key) == KEY_LEN


def test_derive_key_is_deterministic_for_same_salt():
    salt = generate_salt()
    assert bytes(derive_key("master", salt)) == bytes(derive_key("master", salt))


def test_derive_key_differs_by_salt_and_by_password():
    salt_a, salt_b = generate_salt(), generate_salt()
    assert bytes(derive_key("master", salt_a)) != bytes(derive_key("master", salt_b))
    assert bytes(derive_key("master", salt_a)) != bytes(derive_key("other", salt_a))


def test_derive_key_rejects_wrong_salt_length():
    with pytest.raises(Exception):
        derive_key("master", b"tooshort")


def test_salt_and_nonce_are_random_and_correctly_sized():
    salts = {generate_salt() for _ in range(20)}
    nonces = {generate_nonce() for _ in range(20)}
    assert len(salts) == 20 and len(nonces) == 20
    assert all(len(s) == SALT_LEN for s in salts)
    assert all(len(n) == NONCE_LEN for n in nonces)


def test_encrypt_decrypt_round_trip():
    key = derive_key("master", generate_salt())
    aad = header_aad(HEADER)
    nonce, ciphertext = encrypt(key, PLAINTEXT, aad)
    assert decrypt(key, nonce, ciphertext, aad) == PLAINTEXT


def test_ciphertext_does_not_contain_plaintext():
    key = derive_key("master", generate_salt())
    _nonce, ciphertext = encrypt(key, PLAINTEXT, header_aad(HEADER))
    assert b"s3cr3t" not in ciphertext
    assert b"GitHub" not in ciphertext


def test_each_write_uses_a_fresh_nonce():
    key = derive_key("master", generate_salt())
    aad = header_aad(HEADER)
    results = [encrypt(key, PLAINTEXT, aad) for _ in range(10)]
    assert len({nonce for nonce, _ in results}) == 10
    assert len({ct for _, ct in results}) == 10


def test_wrong_key_is_rejected():
    salt = generate_salt()
    aad = header_aad(HEADER)
    nonce, ciphertext = encrypt(derive_key("master", salt), PLAINTEXT, aad)
    with pytest.raises(DecryptionError):
        decrypt(derive_key("wrong", salt), nonce, ciphertext, aad)


def test_tampered_ciphertext_is_rejected():
    key = derive_key("master", generate_salt())
    aad = header_aad(HEADER)
    nonce, ciphertext = encrypt(key, PLAINTEXT, aad)
    for index in (0, len(ciphertext) // 2, len(ciphertext) - 1):
        flipped = bytearray(ciphertext)
        flipped[index] ^= 0x01
        with pytest.raises(DecryptionError):
            decrypt(key, nonce, bytes(flipped), aad)


def test_truncated_ciphertext_is_rejected():
    key = derive_key("master", generate_salt())
    aad = header_aad(HEADER)
    nonce, ciphertext = encrypt(key, PLAINTEXT, aad)
    with pytest.raises(DecryptionError):
        decrypt(key, nonce, ciphertext[:-1], aad)


def test_tampered_nonce_is_rejected():
    key = derive_key("master", generate_salt())
    aad = header_aad(HEADER)
    nonce, ciphertext = encrypt(key, PLAINTEXT, aad)
    flipped = bytearray(nonce)
    flipped[0] ^= 0xFF
    with pytest.raises(DecryptionError):
        decrypt(key, bytes(flipped), ciphertext, aad)


@pytest.mark.parametrize("mutation", [
    {"version": 2},
    {"kdf": {"name": "argon2id", "time_cost": 1}},
    {"salt": "BBBB"},
    {"extra": "injected"},
])
def test_tampered_header_aad_is_rejected(mutation):
    """Editing any header field must break authentication."""
    key = derive_key("master", generate_salt())
    nonce, ciphertext = encrypt(key, PLAINTEXT, header_aad(HEADER))
    tampered = {**HEADER, **mutation}
    with pytest.raises(DecryptionError):
        decrypt(key, nonce, ciphertext, header_aad(tampered))


def test_header_aad_is_canonical_and_order_independent():
    a = header_aad({"version": 1, "salt": "AAAA"})
    b = header_aad({"salt": "AAAA", "version": 1})
    assert a == b
    assert b" " not in a
    assert json.loads(a.decode()) == {"version": 1, "salt": "AAAA"}


def test_decryption_error_message_does_not_leak_the_cause():
    """Wrong password and corrupt vault must be indistinguishable."""
    salt = generate_salt()
    aad = header_aad(HEADER)
    nonce, ciphertext = encrypt(derive_key("master", salt), PLAINTEXT, aad)

    with pytest.raises(DecryptionError) as wrong_password:
        decrypt(derive_key("wrong", salt), nonce, ciphertext, aad)
    tampered = bytearray(ciphertext)
    tampered[0] ^= 0xFF
    with pytest.raises(DecryptionError) as corrupted:
        decrypt(derive_key("master", salt), nonce, bytes(tampered), aad)

    assert str(wrong_password.value) == str(corrupted.value)
    assert str(wrong_password.value) == "wrong master password or corrupted vault"


def test_wipe_zeroises_key_material():
    key = derive_key("master", generate_salt())
    assert any(key)
    wipe(key)
    assert not any(key)
    assert len(key) == KEY_LEN


def test_wipe_tolerates_none_and_empty():
    wipe(None)
    wipe(bytearray())


def test_constant_time_equal():
    assert constant_time_equal("secret", "secret")
    assert constant_time_equal(b"secret", bytearray(b"secret"))
    assert not constant_time_equal("secret", "secrets")
    assert not constant_time_equal("secret", "")


def test_kdf_params_round_trip_and_pinned_values():
    params = KdfParams()
    assert params.time_cost == 3
    assert params.memory_cost == 64 * 1024
    assert params.parallelism == 4
    assert params.key_len == 32
    assert KdfParams.from_dict(params.to_dict()) == params


def test_kdf_params_reject_unknown_algorithm():
    with pytest.raises(Exception):
        KdfParams.from_dict({"name": "pbkdf2", "time_cost": 1, "memory_cost": 1, "parallelism": 1, "key_len": 32})
