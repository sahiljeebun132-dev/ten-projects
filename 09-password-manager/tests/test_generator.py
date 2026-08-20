"""Tests for the password and passphrase generators."""

from __future__ import annotations

import math
import re
import string

import pytest

from pwmgr.generator import (
    AMBIGUOUS,
    DIGITS,
    LOWER,
    SYMBOLS,
    UPPER,
    GeneratorError,
    build_charset,
    describe_strength,
    generate_passphrase,
    generate_password,
    load_wordlist,
    password_entropy_bits,
    passphrase_entropy_bits,
)


# --- length and charset constraints -----------------------------------------

@pytest.mark.parametrize("length", [4, 8, 16, 20, 64, 128])
def test_generated_password_has_requested_length(length):
    assert len(generate_password(length=length)) == length


def test_default_password_includes_every_class():
    for _ in range(25):
        pw = generate_password(length=16)
        assert re.search(r"[a-z]", pw)
        assert re.search(r"[A-Z]", pw)
        assert re.search(r"[0-9]", pw)
        assert any(c in SYMBOLS for c in pw)


def test_disabled_classes_are_absent():
    for _ in range(25):
        pw = generate_password(length=24, symbols=False, digits=False)
        assert not any(c in SYMBOLS for c in pw)
        assert not any(c in DIGITS for c in pw)
        assert all(c in LOWER + UPPER for c in pw)


def test_digits_only_password():
    pw = generate_password(length=12, lower=False, upper=False, symbols=False)
    assert pw.isdigit() and len(pw) == 12


def test_exclude_ambiguous_removes_confusable_glyphs():
    for _ in range(25):
        pw = generate_password(length=40, exclude_ambiguous=True)
        assert not (set(pw) & set(AMBIGUOUS))


def test_exclude_specific_characters():
    pw = generate_password(length=40, exclude_chars="aeiou0123456789")
    assert not (set(pw) & set("aeiou0123456789"))


def test_short_length_is_rejected():
    with pytest.raises(GeneratorError, match="at least"):
        generate_password(length=3)


def test_minimum_length_still_covers_all_four_classes():
    """4 chars is the minimum and is exactly enough for the 4 classes."""
    pw = generate_password(length=4)
    assert len(pw) == 4
    assert len({"lower" if c in LOWER else "upper" if c in UPPER
                else "digit" if c in DIGITS else "symbol" for c in pw}) == 4


def test_length_too_short_for_all_classes_is_rejected(monkeypatch):
    """The guard fires when the length cannot hold one char per class."""
    monkeypatch.setattr("pwmgr.generator.MIN_LENGTH", 1)
    with pytest.raises(GeneratorError, match="character classes"):
        generate_password(length=3, require_each_class=True)


def test_all_classes_disabled_is_rejected():
    with pytest.raises(GeneratorError, match="at least one character class"):
        build_charset(lower=False, upper=False, digits=False, symbols=False)


def test_charset_emptied_by_exclusions_is_rejected():
    with pytest.raises(GeneratorError, match="empty after exclusions"):
        build_charset(upper=False, digits=False, symbols=False, exclude_chars=string.ascii_lowercase)


def test_build_charset_has_no_duplicates():
    charset = build_charset()
    assert len(charset) == len(set(charset))
    assert len(charset) == len(LOWER) + len(UPPER) + len(DIGITS) + len(SYMBOLS)


def test_require_each_class_false_still_uses_full_alphabet():
    pw = generate_password(length=30, require_each_class=False)
    assert len(pw) == 30
    assert set(pw) <= set(build_charset())


# --- randomness quality -----------------------------------------------------

def test_passwords_do_not_repeat():
    passwords = {generate_password(length=20) for _ in range(200)}
    assert len(passwords) == 200


def test_generated_characters_are_spread_across_the_alphabet():
    """A weak PRNG or a bad modulo would cluster the output."""
    sample = "".join(generate_password(length=64, require_each_class=False) for _ in range(60))
    charset = build_charset()
    seen = set(sample)
    # With ~3800 draws from an 88-symbol alphabet, seeing nearly all is expected.
    assert len(seen) > 0.9 * len(charset)


def test_mandatory_class_characters_are_not_always_at_the_front():
    """The shuffle must move the guaranteed characters around."""
    first_chars_are_lower = [generate_password(length=16)[0] in LOWER for _ in range(60)]
    assert not all(first_chars_are_lower)


# --- entropy ----------------------------------------------------------------

def test_password_entropy_formula():
    assert password_entropy_bits(20, 88) == pytest.approx(20 * math.log2(88))
    assert password_entropy_bits(0, 88) == 0.0
    assert password_entropy_bits(20, 1) == 0.0


def test_default_password_entropy_is_strong():
    bits = password_entropy_bits(20, len(build_charset()))
    assert bits > 128
    assert describe_strength(bits) == "very strong"


def test_entropy_drops_when_classes_are_disabled():
    full = password_entropy_bits(12, len(build_charset()))
    digits_only = password_entropy_bits(12, len(build_charset(upper=False, lower=False, symbols=False)))
    assert digits_only < full


@pytest.mark.parametrize("bits,label", [
    (10, "very weak"), (30, "weak"), (45, "reasonable"), (80, "strong"), (200, "very strong"),
])
def test_strength_labels(bits, label):
    assert describe_strength(bits) == label


# --- passphrases ------------------------------------------------------------

def test_wordlist_is_bundled_and_large_enough():
    words = load_wordlist()
    assert len(words) >= 1000
    assert len(set(words)) == len(words), "wordlist must not contain duplicates"
    assert all(w.isalpha() and w.islower() for w in words)


def test_passphrase_word_count_and_separator():
    phrase = generate_passphrase(words=6, separator="-")
    assert len(phrase.split("-")) == 6
    phrase = generate_passphrase(words=4, separator=" ")
    assert len(phrase.split(" ")) == 4


def test_passphrase_words_come_from_the_wordlist():
    words = set(load_wordlist())
    for _ in range(20):
        assert set(generate_passphrase(words=5).split("-")) <= words


def test_passphrase_capitalize_and_number():
    phrase = generate_passphrase(words=4, capitalize=True, add_number=True)
    parts = phrase.split("-")
    assert len(parts) == 5
    assert all(p[0].isupper() for p in parts[:4])
    assert parts[-1].isdigit() and len(parts[-1]) == 2


def test_passphrase_requires_at_least_two_words():
    with pytest.raises(GeneratorError, match="at least 2 words"):
        generate_passphrase(words=1)


def test_passphrases_do_not_repeat():
    assert len({generate_passphrase(words=6) for _ in range(100)}) == 100


def test_passphrase_entropy_matches_wordlist_size():
    size = len(load_wordlist())
    assert passphrase_entropy_bits(6, size) == pytest.approx(6 * math.log2(size))
    assert passphrase_entropy_bits(6) > 60, "6 words should clear 60 bits"


def test_passphrase_uses_a_custom_wordlist():
    phrase = generate_passphrase(words=3, wordlist=["alpha", "beta", "gamma"] * 50)
    assert set(phrase.split("-")) <= {"alpha", "beta", "gamma"}


def test_generator_never_imports_the_random_module():
    """Only 'secrets' (CSPRNG) is acceptable here."""
    import pwmgr.generator as gen_module

    source = open(gen_module.__file__, encoding="utf-8").read()
    assert "import random" not in source
    assert "import secrets" in source
