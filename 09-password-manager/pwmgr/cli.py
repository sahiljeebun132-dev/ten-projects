"""Command line interface for pwmgr.

Run ``python -m pwmgr --help`` (or ``python pwmgr/cli.py --help``) for usage.

Password input rules
--------------------
* On a TTY the master password is read with ``getpass`` (no echo).
* When stdin is a pipe it is read as a line, so the CLI can be scripted and
  tested: ``printf 'pw\\npw\\n' | python -m pwmgr init``.
* The master password is never taken from a command line argument, because
  argv is visible to every process on the machine.
"""

from __future__ import annotations

import argparse
import csv
import getpass
import io
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

if __package__ in (None, ""):  # allow `python pwmgr/cli.py`
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pwmgr import __version__, audit as audit_mod, clipboard, generator
from pwmgr import totp as totp_mod
from pwmgr.crypto import DecryptionError, constant_time_equal
from pwmgr.models import Entry, VaultData
from pwmgr.vault import (
    DEFAULT_AUTOLOCK_MINUTES,
    Vault,
    VaultError,
    file_mode,
    list_backups,
    vault_path_from,
)

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

console = Console(highlight=False)
err_console = Console(stderr=True, highlight=False)

MASK = "*" * 10
EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2

# Minimum acceptable master-password score (audit_mod scale 0-4).
MIN_MASTER_SCORE = 3


# --- input helpers ----------------------------------------------------------

def _stdin_is_tty() -> bool:
    try:
        return sys.stdin.isatty()
    except (AttributeError, ValueError):  # pragma: no cover
        return False


def read_secret(prompt: str) -> str:
    """Read one secret without echoing, or from a pipe when scripted."""
    if _stdin_is_tty():
        return getpass.getpass(prompt)
    line = sys.stdin.readline()
    if not line:
        raise VaultError("no password supplied on stdin")
    return line.rstrip("\n")


def read_master_password(prompt: str = "Master password: ", confirm: bool = False) -> str:
    """Read the master password, optionally asking for confirmation."""
    password = read_secret(prompt)
    if confirm:
        again = read_secret("Confirm master password: ")
        if not constant_time_equal(password, again):
            raise VaultError("passwords do not match")
    return password


def prompt_field(label: str, default: str = "") -> str:
    """Prompt for a non-secret field (interactive only)."""
    if not _stdin_is_tty():
        return default
    suffix = f" [{default}]" if default else ""
    try:
        value = input(f"{label}{suffix}: ").strip()
    except EOFError:
        return default
    return value or default


def confirm_action(question: str, assume_yes: bool = False) -> bool:
    """Yes/no confirmation. Non-interactive runs must pass ``--yes``."""
    if assume_yes:
        return True
    if not _stdin_is_tty():
        return False
    try:
        return input(f"{question} [y/N]: ").strip().lower() in {"y", "yes"}
    except EOFError:
        return False


# --- rendering helpers ------------------------------------------------------

def mask(value: str, show: bool) -> str:
    if show:
        return value or ""
    return MASK if value else ""


def strength_text(score: int, label: str) -> Text:
    colours = {0: "bright_red", 1: "red", 2: "yellow", 3: "green", 4: "bright_green"}
    return Text(label, style=colours.get(score, "white"))


def render_entry(entry: Entry, show: bool = False) -> Panel:
    """A detail panel for a single entry."""
    table = Table.grid(padding=(0, 2))
    table.add_column(style="bold cyan", justify="right")
    table.add_column(overflow="fold")

    strength = audit_mod.score_password(entry.password) if entry.password else None
    rows = [
        ("Username", entry.username),
        ("Password", mask(entry.password, show)),
        ("URL", entry.url),
        ("Tags", ", ".join(entry.tags)),
        ("Notes", entry.notes),
        ("TOTP", "configured" if entry.totp_secret else ""),
        ("Created", entry.created_at),
        ("Updated", entry.updated_at),
        ("ID", entry.id),
    ]
    for label, value in rows:
        if value:
            # Text(), not a markup string: an entry value containing
            # something like "[bold]" must render literally, not be parsed.
            table.add_row(label, Text(str(value)))
    if strength is not None:
        table.add_row("Strength", strength_text(strength.score, f"{strength.label} ({strength.entropy:.0f} bits)"))
    return Panel(table, title=Text(entry.title, style="bold"), border_style="cyan", expand=False)


def render_entries_table(entries: Sequence[Entry], show: bool = False, title: str = "Entries") -> Table:
    table = Table(title=title, title_style="bold", header_style="bold magenta", expand=False)
    table.add_column("Title", style="cyan", no_wrap=True)
    table.add_column("Username")
    table.add_column("Password" if show else "Password", style="dim")
    table.add_column("URL", overflow="fold")
    table.add_column("Tags", style="green")
    table.add_column("TOTP", justify="center")
    table.add_column("Updated", style="dim")
    for entry in sorted(entries, key=lambda e: e.title.lower()):
        table.add_row(
            Text(entry.title),
            Text(entry.username),
            Text(mask(entry.password, show)),
            Text(entry.url),
            Text(", ".join(entry.tags)),
            "yes" if entry.totp_secret else "",
            entry.updated_at[:10],
        )
    return table


def warn(message: str) -> None:
    err_console.print(Text("! ", style="bold yellow") + Text(message))


def fail(message: str) -> None:
    err_console.print(Text("x ", style="bold red") + Text(message))


def ok(message: str) -> None:
    console.print(Text("+ ", style="bold green") + Text(message))


# --- vault helpers ----------------------------------------------------------

def resolve_vault_path(args: argparse.Namespace) -> Path:
    return vault_path_from(getattr(args, "vault", None))


def open_vault(args: argparse.Namespace, password: Optional[str] = None) -> Vault:
    """Prompt (if needed) and unlock the vault."""
    path = resolve_vault_path(args)
    secret = password if password is not None else read_master_password()
    return Vault.open(path, secret, autolock_minutes=getattr(args, "autolock", DEFAULT_AUTOLOCK_MINUTES))


def deliver_secret(value: str, label: str, copy: bool, show: bool) -> None:
    """Print or clipboard-copy a secret, respecting masking rules."""
    if copy:
        try:
            thread = clipboard.copy_with_timeout(value, clipboard.CLEAR_SECONDS)
        except clipboard.ClipboardError as exc:
            fail(str(exc))
            return
        ok(f"{label} copied to clipboard; clearing in {clipboard.CLEAR_SECONDS}s")
        clipboard.wait_for_clear(thread, timeout=clipboard.CLEAR_SECONDS + 5)
        console.print("[dim]clipboard cleared[/dim]")
    elif show:
        console.print(Text(value))
    else:
        console.print(f"[dim]{MASK} (use --show to reveal or --copy for the clipboard)[/dim]")


def parse_tags(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    return [t.strip() for t in raw.split(",") if t.strip()]


# --- commands ---------------------------------------------------------------

def cmd_init(args: argparse.Namespace) -> int:
    path = resolve_vault_path(args)
    if path.exists() and not args.force:
        fail(f"a vault already exists at {path} (use --force to overwrite)")
        return EXIT_ERROR

    console.print(Panel(
        "A new vault is protected by exactly one thing: your master password.\n"
        "It cannot be recovered or reset. Choose a long passphrase and store\n"
        "it somewhere safe (a password of 4+ random words works well).",
        title="[bold]Creating a vault[/bold]",
        border_style="yellow",
        expand=False,
    ))

    password = read_master_password(confirm=True)
    strength = audit_mod.score_password(password)
    console.print(
        "Master password strength: ",
        strength_text(strength.score, strength.label),
        f" ({strength.entropy:.0f} bits)",
        sep="",
    )
    for w in strength.warnings:
        warn(w)
    if strength.score < MIN_MASTER_SCORE and not args.force:
        for s in strength.suggestions:
            console.print(f"  [dim]- {s}[/dim]")
        fail("master password is too weak (use --force to accept it anyway)")
        return EXIT_ERROR

    with Vault.create(path, password, autolock_minutes=args.autolock, overwrite=args.force) as vault:
        ok(f"vault created at {vault.path}")
        console.print(f"  permissions: [bold]{oct(file_mode(vault.path))}[/bold]")
    return EXIT_OK


def cmd_add(args: argparse.Namespace) -> int:
    with open_vault(args) as vault:
        title = args.title or prompt_field("Title")
        if not title:
            fail("a title is required")
            return EXIT_ERROR
        if vault.data.find_by_title(title):
            fail(f"an entry titled {title!r} already exists (use 'edit')")
            return EXIT_ERROR

        if args.generate:
            password = generator.generate_password(
                length=args.length,
                exclude_ambiguous=args.exclude_ambiguous,
            )
        elif args.password is not None:
            password = args.password
        elif _stdin_is_tty():
            password = read_secret("Entry password (blank to generate): ")
            if not password:
                password = generator.generate_password(length=args.length)
                ok("generated a password for this entry")
        else:
            password = generator.generate_password(length=args.length)

        entry = Entry(
            title=title,
            username=args.username or prompt_field("Username"),
            password=password,
            url=args.url or prompt_field("URL"),
            notes=args.notes or prompt_field("Notes"),
            tags=parse_tags(args.tags),
            totp_secret=totp_mod.normalise_secret(args.totp) if args.totp else "",
        )
        vault.data.add(entry)
        vault.save()
        ok(f"added {entry.title!r}")
        console.print(render_entry(entry, show=args.show))
    return EXIT_OK


def cmd_edit(args: argparse.Namespace) -> int:
    with open_vault(args) as vault:
        entry = vault.data.find(args.title)
        if entry is None:
            fail(f"no entry matching {args.title!r}")
            return EXIT_ERROR

        changed = False
        if args.rename:
            existing = vault.data.find_by_title(args.rename)
            if existing is not None and existing.id != entry.id:
                fail(f"an entry titled {args.rename!r} already exists")
                return EXIT_ERROR
            entry.title, changed = args.rename, True
        for attr, value in (
            ("username", args.username),
            ("url", args.url),
            ("notes", args.notes),
        ):
            if value is not None:
                setattr(entry, attr, value)
                changed = True
        if args.tags is not None:
            entry.tags, changed = parse_tags(args.tags), True
        if args.totp is not None:
            entry.totp_secret = totp_mod.normalise_secret(args.totp) if args.totp else ""
            changed = True
        if args.generate:
            entry.password = generator.generate_password(
                length=args.length, exclude_ambiguous=args.exclude_ambiguous
            )
            changed = True
        elif args.password is not None:
            entry.password, changed = args.password, True
        elif args.prompt_password:
            entry.password, changed = read_secret("New entry password: "), True

        if not changed:
            warn("nothing to change")
            return EXIT_OK

        entry.touch()
        vault.save()
        ok(f"updated {entry.title!r}")
        console.print(render_entry(entry, show=args.show))
    return EXIT_OK


def cmd_remove(args: argparse.Namespace) -> int:
    with open_vault(args) as vault:
        entry = vault.data.find(args.title)
        if entry is None:
            fail(f"no entry matching {args.title!r}")
            return EXIT_ERROR
        if not confirm_action(f"Delete {entry.title!r}?", args.yes):
            warn("cancelled (pass --yes to confirm non-interactively)")
            return EXIT_ERROR
        vault.data.remove(entry.id)
        vault.save()
        ok(f"removed {entry.title!r}")
    return EXIT_OK


def cmd_get(args: argparse.Namespace) -> int:
    with open_vault(args) as vault:
        entry = vault.data.find(args.title)
        if entry is None:
            matches = vault.data.search(args.title)
            if len(matches) == 1:
                entry = matches[0]
            elif matches:
                warn(f"{len(matches)} entries match {args.title!r}; be more specific")
                console.print(render_entries_table(matches, show=False, title="Matches"))
                return EXIT_ERROR
            else:
                fail(f"no entry matching {args.title!r}")
                return EXIT_ERROR

        if args.copy:
            deliver_secret(entry.password, f"password for {entry.title!r}", True, args.show)
        elif args.password_only:
            deliver_secret(entry.password, entry.title, False, args.show)
        else:
            console.print(render_entry(entry, show=args.show))
    return EXIT_OK


def cmd_list(args: argparse.Namespace) -> int:
    with open_vault(args) as vault:
        entries = vault.data.entries
        if args.tag:
            wanted = args.tag.lower()
            entries = [e for e in entries if wanted in [t.lower() for t in e.tags]]
        if not entries:
            warn("vault is empty" if not args.tag else f"no entries tagged {args.tag!r}")
            return EXIT_OK
        console.print(render_entries_table(entries, show=args.show, title=f"Entries ({len(entries)})"))
    return EXIT_OK


def cmd_search(args: argparse.Namespace) -> int:
    with open_vault(args) as vault:
        matches = vault.data.search(args.query)
        if not matches:
            warn(f"nothing matches {args.query!r}")
            return EXIT_OK
        console.print(render_entries_table(matches, show=args.show, title=f"Matches for {args.query!r}"))
    return EXIT_OK


def cmd_gen(args: argparse.Namespace) -> int:
    """Generate passwords; needs no vault."""
    results: List[str] = []
    try:
        for _ in range(max(1, args.count)):
            if args.words:
                results.append(
                    generator.generate_passphrase(
                        words=args.words,
                        separator=args.separator,
                        capitalize=args.capitalize,
                        add_number=args.add_number,
                    )
                )
            else:
                results.append(
                    generator.generate_password(
                        length=args.length,
                        lower=not args.no_lower,
                        upper=not args.no_upper,
                        digits=not args.no_digits,
                        symbols=not args.no_symbols,
                        exclude_ambiguous=args.exclude_ambiguous,
                        exclude_chars=args.exclude or "",
                    )
                )
    except generator.GeneratorError as exc:
        fail(str(exc))
        return EXIT_ERROR

    if args.words:
        bits = generator.passphrase_entropy_bits(args.words)
        detail = f"{args.words} words from a {len(generator.load_wordlist())}-word list"
    else:
        charset = generator.build_charset(
            lower=not args.no_lower,
            upper=not args.no_upper,
            digits=not args.no_digits,
            symbols=not args.no_symbols,
            exclude_ambiguous=args.exclude_ambiguous,
            exclude_chars=args.exclude or "",
        )
        bits = generator.password_entropy_bits(args.length, len(charset))
        detail = f"{args.length} chars from a {len(charset)}-symbol alphabet"

    for value in results:
        console.print(Text(value, style="bold"))
    console.print(
        f"[dim]{detail} = {bits:.0f} bits ({generator.describe_strength(bits)})[/dim]"
    )

    if args.copy:
        deliver_secret(results[0], "generated password", True, False)
    return EXIT_OK


def cmd_totp(args: argparse.Namespace) -> int:
    with open_vault(args) as vault:
        entry = vault.data.find(args.title)
        if entry is None:
            fail(f"no entry matching {args.title!r}")
            return EXIT_ERROR
        if not entry.totp_secret:
            fail(f"{entry.title!r} has no TOTP secret (add one with 'edit --totp')")
            return EXIT_ERROR
        try:
            code = totp_mod.totp(entry.totp_secret)
        except totp_mod.TOTPError as exc:
            fail(str(exc))
            return EXIT_ERROR
        remaining = totp_mod.seconds_remaining()
        console.print(f"[bold green]{code}[/bold green] [dim]valid for {remaining}s[/dim]")
        if args.copy:
            deliver_secret(code, "TOTP code", True, False)
    return EXIT_OK


def cmd_audit(args: argparse.Namespace) -> int:
    with open_vault(args) as vault:
        report = audit_mod.audit_entries(vault.data.entries, stale_days=args.stale_days)
        if report.total_entries == 0:
            warn("vault is empty; nothing to audit")
            return EXIT_OK

        summary = Table.grid(padding=(0, 3))
        summary.add_column(style="bold")
        summary.add_column(justify="right")
        summary.add_row("Entries", str(report.total_entries))
        summary.add_row("[red]Weak[/red]", str(len(report.weak)))
        summary.add_row("[red]Reused[/red]", str(len({f.entry_title for f in report.reused})))
        summary.add_row("[yellow]Stale[/yellow]", str(len(report.stale)))
        console.print(Panel(summary, title="[bold]Audit summary[/bold]", border_style="magenta", expand=False))

        if report.ok:
            ok("no problems found")
            return EXIT_OK

        table = Table(header_style="bold magenta", expand=False)
        table.add_column("Issue", style="bold")
        table.add_column("Entry", style="cyan")
        table.add_column("Detail", overflow="fold")
        styles = {"high": "red", "medium": "yellow", "low": "dim"}
        for finding in report.findings:
            table.add_row(
                Text(finding.kind, style=styles.get(finding.severity, "white")),
                Text(finding.entry_title),
                Text(finding.detail),
            )
        console.print(table)
        return EXIT_ERROR if args.strict else EXIT_OK


def cmd_export(args: argparse.Namespace) -> int:
    dest = Path(args.out).expanduser()
    with open_vault(args) as vault:
        if not args.plaintext:
            vault.export_encrypted(dest)
            ok(f"encrypted export written to {dest} ({len(vault.data.entries)} entries)")
            console.print("[dim]open it with the same master password[/dim]")
            return EXIT_OK

        console.print(Panel(
            "This writes every password to disk in CLEAR TEXT.\n"
            "Anything that can read the file - backups, sync clients, other\n"
            "users, your shell history - can read your passwords.\n"
            "Delete the file (ideally with 'shred') as soon as you are done.",
            title="[bold red]PLAINTEXT EXPORT[/bold red]",
            border_style="red",
            expand=False,
        ))
        if not confirm_action("Write plaintext export?", args.yes):
            warn("cancelled (pass --yes to confirm non-interactively)")
            return EXIT_ERROR

        entries = [e.to_dict() for e in vault.data.entries]
        if args.format == "csv":
            payload = _entries_to_csv(entries)
        else:
            payload = json.dumps({"entries": entries}, indent=2)
        _write_plaintext(dest, payload)
        ok(f"PLAINTEXT export written to {dest} ({len(entries)} entries)")
        warn("delete this file as soon as you have imported it elsewhere")
    return EXIT_OK


def _entries_to_csv(entries: List[Dict[str, Any]]) -> str:
    fields = ["title", "username", "password", "url", "notes", "tags", "totp_secret", "created_at", "updated_at"]
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    for entry in entries:
        row = dict(entry)
        row["tags"] = ",".join(row.get("tags") or [])
        writer.writerow(row)
    return buf.getvalue()


def _write_plaintext(dest: Path, payload: str) -> None:
    """Write a plaintext export at 0600, never world-readable."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(dest), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(payload)
    os.chmod(dest, 0o600)


def _read_import_file(path: Path, fmt: str) -> List[Entry]:
    """Parse a plaintext JSON or CSV file into entries."""
    text = path.read_text(encoding="utf-8")
    if fmt == "auto":
        fmt = "json" if path.suffix.lower() == ".json" or text.lstrip().startswith(("{", "[")) else "csv"

    if fmt == "json":
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise VaultError(f"{path} is not valid JSON: {exc}") from exc
        rows = data.get("entries", []) if isinstance(data, dict) else data
        if not isinstance(rows, list):
            raise VaultError(f"{path} does not contain a list of entries")
    else:
        rows = list(csv.DictReader(io.StringIO(text)))

    entries: List[Entry] = []
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        row = {(k or "").strip().lower(): v for k, v in raw.items()}
        # Accept the column names other managers commonly emit.
        aliases = {
            "name": "title",
            "account": "title",
            "login": "username",
            "user": "username",
            "email": "username",
            "pass": "password",
            "website": "url",
            "site": "url",
            "note": "notes",
            "comments": "notes",
            "otp": "totp_secret",
            "totp": "totp_secret",
            "otpauth": "totp_secret",
        }
        for src, dst in aliases.items():
            if src in row and not row.get(dst):
                row[dst] = row[src]
        if not (row.get("title") or "").strip():
            continue
        entries.append(Entry.from_dict(row))
    return entries


def cmd_import(args: argparse.Namespace) -> int:
    source = Path(args.source).expanduser()
    if not source.exists():
        fail(f"no such file: {source}")
        return EXIT_ERROR

    console.print(Panel(
        Text(
            f"{source} is a PLAINTEXT credential file.\n"
            "Its contents are readable by anything on this machine, and it may\n"
            "already have leaked into backups or your shell history.\n"
            "After importing, delete it - ideally with 'shred -u'."
        ),
        title="[bold red]PLAINTEXT IMPORT[/bold red]",
        border_style="red",
        expand=False,
    ))

    try:
        incoming = _read_import_file(source, args.format)
    except VaultError as exc:
        fail(str(exc))
        return EXIT_ERROR
    if not incoming:
        warn("no importable entries found")
        return EXIT_OK

    if not confirm_action(f"Import {len(incoming)} entries?", args.yes):
        warn("cancelled (pass --yes to confirm non-interactively)")
        return EXIT_ERROR

    with open_vault(args) as vault:
        added = skipped = replaced = 0
        for entry in incoming:
            existing = vault.data.find_by_title(entry.title)
            if existing is not None:
                if not args.overwrite:
                    skipped += 1
                    continue
                vault.data.remove(existing.id)
                replaced += 1
            vault.data.add(entry)
            added += 1
        vault.save()

    ok(f"imported {added} entries ({replaced} replaced, {skipped} skipped as duplicates)")
    warn(f"now delete the plaintext file: shred -u {source}")
    return EXIT_OK


def cmd_change_master(args: argparse.Namespace) -> int:
    path = resolve_vault_path(args)
    current = read_master_password("Current master password: ")
    with Vault.open(path, current, autolock_minutes=args.autolock) as vault:
        new_password = read_master_password("New master password: ", confirm=True)
        if constant_time_equal(current, new_password):
            fail("the new master password is the same as the old one")
            return EXIT_ERROR

        strength = audit_mod.score_password(new_password)
        console.print("New master password strength: ", strength_text(strength.score, strength.label), sep="")
        if strength.score < MIN_MASTER_SCORE and not args.force:
            for w in strength.warnings:
                warn(w)
            fail("new master password is too weak (use --force to accept it anyway)")
            return EXIT_ERROR

        vault.change_master_password(new_password)
        ok("master password changed; the vault was re-encrypted with a fresh salt and key")
        backups = list_backups(path)
        if backups:
            warn(f"{len(backups)} backup(s) in {backups[0].parent} still open with the OLD password")
    return EXIT_OK


def cmd_shell(args: argparse.Namespace) -> int:
    """A tiny REPL that unlocks the vault once."""
    path = resolve_vault_path(args)
    password = read_master_password()
    vault = Vault.open(path, password, autolock_minutes=args.autolock)
    del password

    console.print(Panel(
        "Commands: list, search <q>, get <title>, show <title>, copy <title>,\n"
        "          add <title>, remove <title>, totp <title>, gen \\[len],\n"
        "          audit, lock, help, quit",
        title=f"[bold]pwmgr shell[/bold] [dim]{path}[/dim]",
        border_style="cyan",
        expand=False,
    ))
    if vault.autolock_minutes > 0:
        console.print(f"[dim]auto-locks after {vault.autolock_minutes:g} minutes idle[/dim]")

    try:
        while True:
            try:
                line = input("pwmgr> ").strip()
            except (EOFError, KeyboardInterrupt):
                console.print()
                break
            if not line:
                continue

            if vault.check_autolock():
                warn("vault auto-locked after inactivity")
                try:
                    vault = Vault.open(path, read_master_password(), autolock_minutes=args.autolock)
                except (DecryptionError, VaultError) as exc:
                    fail(str(exc))
                    break
            vault.touch()

            command, _, rest = line.partition(" ")
            rest = rest.strip()
            command = command.lower()

            try:
                if command in {"quit", "exit", "q"}:
                    break
                if command in {"help", "?"}:
                    console.print(
                        "list | search <q> | get <t> | show <t> | copy <t> | add <t> | "
                        "remove <t> | totp <t> | gen \\[len] | audit | lock | quit"
                    )
                elif command == "lock":
                    vault.lock()
                    ok("locked")
                    break
                elif command == "list":
                    if vault.data.entries:
                        console.print(render_entries_table(vault.data.entries, show=False))
                    else:
                        warn("vault is empty")
                elif command == "search":
                    matches = vault.data.search(rest)
                    console.print(render_entries_table(matches, show=False)) if matches else warn("no matches")
                elif command in {"get", "show"}:
                    entry = vault.data.find(rest)
                    console.print(render_entry(entry, show=(command == "show"))) if entry else fail("no such entry")
                elif command == "copy":
                    entry = vault.data.find(rest)
                    if entry is None:
                        fail("no such entry")
                    else:
                        deliver_secret(entry.password, f"password for {entry.title!r}", True, False)
                elif command == "add":
                    if not rest:
                        fail("usage: add <title>")
                    elif vault.data.find_by_title(rest):
                        fail("an entry with that title already exists")
                    else:
                        entry = Entry(
                            title=rest,
                            username=prompt_field("Username"),
                            password=read_secret("Password (blank to generate): ") or generator.generate_password(),
                            url=prompt_field("URL"),
                            tags=parse_tags(prompt_field("Tags (comma separated)")),
                        )
                        vault.data.add(entry)
                        vault.save()
                        ok(f"added {entry.title!r}")
                elif command == "remove":
                    entry = vault.data.find(rest)
                    if entry is None:
                        fail("no such entry")
                    elif confirm_action(f"Delete {entry.title!r}?"):
                        vault.data.remove(entry.id)
                        vault.save()
                        ok("removed")
                elif command == "totp":
                    entry = vault.data.find(rest)
                    if entry is None or not entry.totp_secret:
                        fail("no such entry, or it has no TOTP secret")
                    else:
                        console.print(
                            f"[bold green]{totp_mod.totp(entry.totp_secret)}[/bold green] "
                            f"[dim]valid for {totp_mod.seconds_remaining()}s[/dim]"
                        )
                elif command == "gen":
                    length = int(rest) if rest.isdigit() else generator.DEFAULT_LENGTH
                    console.print(Text(generator.generate_password(length=length), style="bold"))
                elif command == "audit":
                    report = audit_mod.audit_entries(vault.data.entries)
                    if report.ok:
                        ok("no problems found")
                    else:
                        for finding in report.findings:
                            console.print(
                                Text(finding.kind, style="yellow")
                                + Text(f" {finding.entry_title}: {finding.detail}")
                            )
                else:
                    fail(f"unknown command {command!r} (try 'help')")
            except (VaultError, ValueError, totp_mod.TOTPError, generator.GeneratorError) as exc:
                fail(str(exc))
    finally:
        vault.lock()
        console.print("[dim]vault locked[/dim]")
    return EXIT_OK


# --- argument parsing -------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pwmgr",
        description="A local, offline, encrypted password vault (Argon2id + AES-256-GCM).",
        epilog="The master password is read from the terminal or stdin, never from argv.",
    )
    parser.add_argument("--version", action="version", version=f"pwmgr {__version__}")
    parser.add_argument("--vault", help="vault path (default: $PWMGR_VAULT or ~/.pwmgr/vault.json)")
    parser.add_argument(
        "--autolock",
        type=float,
        default=DEFAULT_AUTOLOCK_MINUTES,
        metavar="MINUTES",
        help="auto-lock after this many idle minutes (0 disables; default %(default)s)",
    )
    sub = parser.add_subparsers(dest="command", metavar="<command>")

    p = sub.add_parser("init", help="create a new vault")
    p.add_argument("--force", action="store_true", help="overwrite an existing vault / accept a weak master password")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("add", help="add an entry")
    p.add_argument("title", nargs="?")
    p.add_argument("--username", "-u")
    p.add_argument("--password", "-p", help="entry password (avoid on shared machines: argv is public)")
    p.add_argument("--generate", "-g", action="store_true", help="generate the password")
    p.add_argument("--length", type=int, default=generator.DEFAULT_LENGTH)
    p.add_argument("--exclude-ambiguous", action="store_true")
    p.add_argument("--url")
    p.add_argument("--notes")
    p.add_argument("--tags", help="comma separated")
    p.add_argument("--totp", help="base32 TOTP secret")
    p.add_argument("--show", action="store_true", help="reveal the password in the output")
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("edit", help="edit an entry")
    p.add_argument("title")
    p.add_argument("--rename")
    p.add_argument("--username")
    p.add_argument("--password")
    p.add_argument("--prompt-password", action="store_true", help="prompt for a new password")
    p.add_argument("--generate", "-g", action="store_true")
    p.add_argument("--length", type=int, default=generator.DEFAULT_LENGTH)
    p.add_argument("--exclude-ambiguous", action="store_true")
    p.add_argument("--url")
    p.add_argument("--notes")
    p.add_argument("--tags", help="comma separated (replaces existing tags)")
    p.add_argument("--totp", help="base32 TOTP secret ('' clears it)")
    p.add_argument("--show", action="store_true")
    p.set_defaults(func=cmd_edit)

    p = sub.add_parser("remove", aliases=["rm"], help="delete an entry")
    p.add_argument("title")
    p.add_argument("--yes", "-y", action="store_true")
    p.set_defaults(func=cmd_remove)

    p = sub.add_parser("get", help="show one entry")
    p.add_argument("title")
    p.add_argument("--show", "-s", action="store_true", help="reveal the password")
    p.add_argument("--copy", "-c", action="store_true", help="copy the password to the clipboard")
    p.add_argument("--password-only", action="store_true", help="print only the password field")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("list", aliases=["ls"], help="list entries")
    p.add_argument("--tag")
    p.add_argument("--show", "-s", action="store_true")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("search", help="search titles, usernames, URLs, notes and tags")
    p.add_argument("query")
    p.add_argument("--show", "-s", action="store_true")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("gen", help="generate a password or passphrase")
    p.add_argument("--length", "-l", type=int, default=generator.DEFAULT_LENGTH)
    p.add_argument("--count", "-n", type=int, default=1)
    p.add_argument("--words", "-w", type=int, help="diceware passphrase with this many words")
    p.add_argument("--separator", default="-")
    p.add_argument("--capitalize", action="store_true")
    p.add_argument("--add-number", action="store_true")
    p.add_argument("--no-upper", action="store_true")
    p.add_argument("--no-lower", action="store_true")
    p.add_argument("--no-digits", action="store_true")
    p.add_argument("--no-symbols", action="store_true")
    p.add_argument("--exclude-ambiguous", "-a", action="store_true")
    p.add_argument("--exclude", help="additional characters to exclude")
    p.add_argument("--copy", "-c", action="store_true")
    p.set_defaults(func=cmd_gen)

    p = sub.add_parser("totp", help="generate a TOTP code for an entry")
    p.add_argument("title")
    p.add_argument("--copy", "-c", action="store_true")
    p.set_defaults(func=cmd_totp)

    p = sub.add_parser("audit", help="report weak, reused and stale passwords")
    p.add_argument("--stale-days", type=int, default=audit_mod.STALE_DAYS)
    p.add_argument("--strict", action="store_true", help="exit non-zero when findings exist")
    p.set_defaults(func=cmd_audit)

    p = sub.add_parser("export", help="export the vault (encrypted by default)")
    p.add_argument("out")
    p.add_argument("--plaintext", action="store_true", help="DANGEROUS: export unencrypted")
    p.add_argument("--format", choices=["json", "csv"], default="json", help="plaintext export format")
    p.add_argument("--yes", "-y", action="store_true")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("import", help="import entries from a plaintext JSON or CSV file")
    p.add_argument("source")
    p.add_argument("--format", choices=["auto", "json", "csv"], default="auto")
    p.add_argument("--overwrite", action="store_true", help="replace entries with the same title")
    p.add_argument("--yes", "-y", action="store_true")
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("change-master", help="change the master password")
    p.add_argument("--force", action="store_true", help="accept a weak new master password")
    p.set_defaults(func=cmd_change_master)

    p = sub.add_parser("shell", help="interactive REPL")
    p.set_defaults(func=cmd_shell)

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return EXIT_USAGE

    try:
        return int(args.func(args))
    except DecryptionError as exc:
        fail(str(exc))
        return EXIT_ERROR
    except (VaultError, generator.GeneratorError, totp_mod.TOTPError, ValueError) as exc:
        fail(str(exc))
        return EXIT_ERROR
    except PermissionError as exc:
        fail(f"permission denied: {exc}")
        return EXIT_ERROR
    except KeyboardInterrupt:
        err_console.print("\n[dim]aborted[/dim]")
        return 130


if __name__ == "__main__":
    sys.exit(main())
