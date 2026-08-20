"""Vault data model: entries and the in-memory vault body."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional


def utcnow_iso() -> str:
    """Current UTC time as a stable ISO-8601 string with 'Z' suffix."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    """Parse an ISO-8601 timestamp; always returns an aware UTC datetime."""
    text = (value or "").strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def age_days(value: str, *, now: Optional[datetime] = None) -> float:
    """Age in days of an ISO timestamp. Unparseable timestamps read as 0."""
    now = now or datetime.now(timezone.utc)
    try:
        return (now - parse_iso(value)).total_seconds() / 86400.0
    except (ValueError, TypeError):
        return 0.0


@dataclass
class Entry:
    """A single credential record."""

    title: str
    username: str = ""
    password: str = ""
    url: str = ""
    notes: str = ""
    tags: List[str] = field(default_factory=list)
    totp_secret: str = ""
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    created_at: str = field(default_factory=utcnow_iso)
    updated_at: str = field(default_factory=utcnow_iso)

    def touch(self) -> None:
        """Mark the entry as modified now."""
        self.updated_at = utcnow_iso()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "username": self.username,
            "password": self.password,
            "url": self.url,
            "notes": self.notes,
            "tags": list(self.tags),
            "totp_secret": self.totp_secret,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Entry":
        """Build an Entry from untrusted-ish dict data, tolerating gaps."""
        tags = data.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]
        created = str(data.get("created_at") or utcnow_iso())
        return cls(
            id=str(data.get("id") or uuid.uuid4().hex),
            title=str(data.get("title") or ""),
            username=str(data.get("username") or ""),
            password=str(data.get("password") or ""),
            url=str(data.get("url") or ""),
            notes=str(data.get("notes") or ""),
            tags=[str(t) for t in tags],
            totp_secret=str(data.get("totp_secret") or ""),
            created_at=created,
            updated_at=str(data.get("updated_at") or created),
        )

    def matches(self, needle: str) -> bool:
        """Case-insensitive substring search across the non-secret fields.

        Passwords and TOTP secrets are intentionally excluded: searching by
        password value would let a shoulder-surfer confirm a guess.
        """
        needle = needle.lower()
        haystacks: Iterable[str] = (
            self.title,
            self.username,
            self.url,
            self.notes,
            " ".join(self.tags),
        )
        return any(needle in (h or "").lower() for h in haystacks)


@dataclass
class VaultData:
    """The decrypted vault body."""

    entries: List[Entry] = field(default_factory=list)
    created_at: str = field(default_factory=utcnow_iso)
    updated_at: str = field(default_factory=utcnow_iso)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "entries": [e.to_dict() for e in self.entries],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "VaultData":
        created = str(data.get("created_at") or utcnow_iso())
        return cls(
            entries=[Entry.from_dict(e) for e in data.get("entries", [])],
            created_at=created,
            updated_at=str(data.get("updated_at") or created),
        )

    # --- lookup helpers ---------------------------------------------------
    def find_by_title(self, title: str) -> Optional[Entry]:
        """Exact (case-insensitive) title match, else None."""
        low = title.lower()
        for entry in self.entries:
            if entry.title.lower() == low:
                return entry
        return None

    def find(self, identifier: str) -> Optional[Entry]:
        """Resolve an entry by id or by exact title."""
        for entry in self.entries:
            if entry.id == identifier:
                return entry
        return self.find_by_title(identifier)

    def search(self, needle: str) -> List[Entry]:
        return [e for e in self.entries if e.matches(needle)]

    def add(self, entry: Entry) -> None:
        if self.find_by_title(entry.title):
            raise ValueError(f"an entry titled {entry.title!r} already exists")
        self.entries.append(entry)
        self.updated_at = utcnow_iso()

    def remove(self, identifier: str) -> bool:
        entry = self.find(identifier)
        if entry is None:
            return False
        self.entries.remove(entry)
        self.updated_at = utcnow_iso()
        return True
