"""Password and passphrase generation, backed by :mod:`secrets`.

Every random choice here goes through ``secrets`` (the OS CSPRNG). The
``random`` module is deliberately never imported.
"""

from __future__ import annotations

import math
import secrets
import string
from functools import lru_cache
from pathlib import Path
from typing import List, Optional, Sequence

DATA_DIR = Path(__file__).resolve().parent / "data"
WORDLIST_PATH = DATA_DIR / "wordlist.txt"

LOWER = string.ascii_lowercase
UPPER = string.ascii_uppercase
DIGITS = string.digits
SYMBOLS = "!#$%&()*+,-./:;<=>?@[]^_{|}~"

# Glyphs that are easy to confuse in most fonts.
AMBIGUOUS = "0O1lI|`'\"5S2Z8B"

DEFAULT_LENGTH = 20
MIN_LENGTH = 4
DEFAULT_WORDS = 6


class GeneratorError(Exception):
    """Raised when the requested generator settings are impossible."""


@lru_cache(maxsize=1)
def load_wordlist(path: Optional[str] = None) -> tuple[str, ...]:
    """Load the bundled diceware-style wordlist (cached)."""
    target = Path(path) if path else WORDLIST_PATH
    if not target.exists():
        raise GeneratorError(f"wordlist not found at {target}")
    words = tuple(
        w.strip().lower()
        for w in target.read_text(encoding="utf-8").splitlines()
        if w.strip()
    )
    if len(words) < 128:
        raise GeneratorError("wordlist is too small to generate safe passphrases")
    return words


def build_charset(
    lower: bool = True,
    upper: bool = True,
    digits: bool = True,
    symbols: bool = True,
    exclude_ambiguous: bool = False,
    exclude_chars: str = "",
) -> str:
    """Assemble the alphabet from the enabled classes.

    Returns a deduplicated, order-stable string. Raises if the result is
    empty (e.g. every class disabled, or everything excluded).
    """
    pool = ""
    if lower:
        pool += LOWER
    if upper:
        pool += UPPER
    if digits:
        pool += DIGITS
    if symbols:
        pool += SYMBOLS
    if not pool:
        raise GeneratorError("at least one character class must be enabled")

    banned = set(exclude_chars)
    if exclude_ambiguous:
        banned |= set(AMBIGUOUS)

    seen: set[str] = set()
    charset = []
    for ch in pool:
        if ch in banned or ch in seen:
            continue
        seen.add(ch)
        charset.append(ch)
    if not charset:
        raise GeneratorError("character set is empty after exclusions")
    return "".join(charset)


def _required_classes(
    charset: str,
    lower: bool,
    upper: bool,
    digits: bool,
    symbols: bool,
) -> List[str]:
    """The per-class sub-alphabets that the result must each draw from.

    A class that survived the exclusion filter with zero members is dropped
    rather than making generation impossible.
    """
    groups = []
    for enabled, members in (
        (lower, LOWER),
        (upper, UPPER),
        (digits, DIGITS),
        (symbols, SYMBOLS),
    ):
        if not enabled:
            continue
        available = [c for c in charset if c in members]
        if available:
            groups.append("".join(available))
    return groups


def generate_password(
    length: int = DEFAULT_LENGTH,
    lower: bool = True,
    upper: bool = True,
    digits: bool = True,
    symbols: bool = True,
    exclude_ambiguous: bool = False,
    exclude_chars: str = "",
    require_each_class: bool = True,
) -> str:
    """Generate a random password.

    With ``require_each_class`` the result contains at least one character
    from every enabled class. This is done by drawing one mandatory char per
    class and filling the rest from the full alphabet, then shuffling with a
    CSPRNG Fisher-Yates - never by regenerating until a pattern matches.
    """
    if length < MIN_LENGTH:
        raise GeneratorError(f"length must be at least {MIN_LENGTH}")

    charset = build_charset(lower, upper, digits, symbols, exclude_ambiguous, exclude_chars)

    if not require_each_class:
        return "".join(secrets.choice(charset) for _ in range(length))

    groups = _required_classes(charset, lower, upper, digits, symbols)
    if len(groups) > length:
        raise GeneratorError(
            f"length {length} is too short to include all {len(groups)} character classes"
        )

    chars = [secrets.choice(group) for group in groups]
    chars += [secrets.choice(charset) for _ in range(length - len(chars))]
    _shuffle(chars)
    return "".join(chars)


def generate_passphrase(
    words: int = DEFAULT_WORDS,
    separator: str = "-",
    capitalize: bool = False,
    add_number: bool = False,
    wordlist: Optional[Sequence[str]] = None,
) -> str:
    """Generate a diceware-style passphrase from the bundled wordlist.

    Words are drawn independently *with* replacement, which is what the
    entropy estimate ``words * log2(len(wordlist))`` assumes.
    """
    if words < 2:
        raise GeneratorError("a passphrase needs at least 2 words")
    pool = tuple(wordlist) if wordlist else load_wordlist()

    chosen = [secrets.choice(pool) for _ in range(words)]
    if capitalize:
        chosen = [w.capitalize() for w in chosen]
    phrase = separator.join(chosen)
    if add_number:
        phrase += separator + str(secrets.randbelow(100)).zfill(2)
    return phrase


def _shuffle(items: List[str]) -> None:
    """In-place Fisher-Yates shuffle using the CSPRNG."""
    for i in range(len(items) - 1, 0, -1):
        j = secrets.randbelow(i + 1)
        items[i], items[j] = items[j], items[i]


def password_entropy_bits(length: int, charset_size: int) -> float:
    """Entropy of a uniformly random string: ``length * log2(charset)``."""
    if length <= 0 or charset_size <= 1:
        return 0.0
    return length * math.log2(charset_size)


def passphrase_entropy_bits(words: int, wordlist_size: Optional[int] = None) -> float:
    """Entropy of a diceware passphrase: ``words * log2(wordlist)``."""
    size = wordlist_size if wordlist_size is not None else len(load_wordlist())
    if words <= 0 or size <= 1:
        return 0.0
    return words * math.log2(size)


def describe_strength(bits: float) -> str:
    """Coarse human label for an entropy estimate."""
    if bits < 28:
        return "very weak"
    if bits < 36:
        return "weak"
    if bits < 60:
        return "reasonable"
    if bits < 128:
        return "strong"
    return "very strong"
