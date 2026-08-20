# pwmgr - a local, offline password manager

An encrypted credential vault that lives in a single file on your own
machine. No accounts, no sync, no network code, no telemetry. In the spirit
of `pass` and KeePass: **Argon2id** to turn your master password into a
key, **AES-256-GCM** to encrypt everything else.

> ### Read this first
> **This is a learning project.** It was written to demonstrate a
> password-manager design end to end, and while the cryptography follows
> current best practice and is covered by tests (including the RFC 6238
> TOTP vectors), it has **not** had an independent security audit.
> **Audit it yourself before trusting it with real secrets.** For
> production use, prefer something with a track record and a bug bounty:
> KeePassXC, `pass`, 1Password, Bitwarden.

---

## What it does

- **One encrypted file.** Argon2id (64 MiB, t=3, p=4) derives a 32-byte key
  from your master password; AES-256-GCM encrypts the body with a fresh
  nonce per write. The header (version, KDF parameters, salt) is
  authenticated as AAD so it cannot be tampered with or downgraded.
- **Full entry model.** Title, username, password, URL, notes, tags,
  created/updated timestamps, and an optional TOTP secret.
- **Two-factor codes.** RFC 6238 TOTP implemented directly on `hmac`/
  `hashlib` and tested against the published RFC vectors (SHA-1, SHA-256
  and SHA-512).
- **Password generation.** Configurable character classes, ambiguous-glyph
  exclusion, and a diceware-style passphrase mode with a bundled 2000-word
  list - all driven by `secrets`.
- **Hygiene auditing.** Flags weak passwords (length, character variety, a
  bundled common-password list, keyboard runs, sequences, repeats,
  leetspeak-decoded lookups), passwords reused across entries, and entries
  not touched in over a year.
- **Safe on disk.** Atomic writes, `0600` permissions, and 5 rotating
  timestamped backups taken before every write.
- **Exposure controls.** Idle auto-lock, clipboard auto-clear after 20
  seconds, masked output by default.

---

## Threat model in one screen

**It protects you against** someone stealing the vault file or the whole
powered-off laptop, cloud-sync/backup exposure, silent tampering with the
file, KDF-downgrade attacks, other local users reading the file, crashes
during a save, and your own password reuse.

**It does NOT protect you against a compromised machine.** Malware or a
keylogger running as your user can capture your master password as you type
it, read the clipboard, and read pwmgr's memory while the vault is
unlocked. No user-space password manager can prevent that. It also cannot
save you from a weak master password, from root on your own box, or from
losing the master password - there is **no recovery and no backdoor**.

The header also reveals that a vault exists and roughly how big it is;
contents are hidden, existence is not.

Full detail, including the memory-zeroisation caveats and the reasoning
behind each choice, is in **[SECURITY.md](SECURITY.md)**.

---

## Install

Python 3.11+.

```bash
pip install --break-system-packages -r requirements.txt
```

Run it from the project directory:

```bash
python -m pwmgr --help
# or
python pwmgr/cli.py --help
```

Optional convenience alias:

```bash
alias pwmgr='python -m pwmgr'
```

On Linux, `--copy` needs a clipboard backend: `xclip`, `xsel`, or
`wl-clipboard`. Without one, pwmgr says so and falls back to `--show`.

### Where the vault lives

`~/.pwmgr/vault.json` by default. Override per-command with `--vault PATH`,
or globally with the `PWMGR_VAULT` environment variable.

---

## Quick start

```bash
python -m pwmgr init                                  # create the vault
python -m pwmgr add GitHub -u octocat -g --tags dev   # add, generated password
python -m pwmgr get GitHub --copy                     # copy for 20 seconds
python -m pwmgr audit                                 # check your hygiene
```

---

## Command reference

Global options, valid before any subcommand:

| Option | Meaning |
|---|---|
| `--vault PATH` | Vault file (default `$PWMGR_VAULT`, else `~/.pwmgr/vault.json`) |
| `--autolock MINUTES` | Idle auto-lock, default `5`; `0` disables |
| `--version`, `-h` | Version / help |

The master password is always read from the terminal (no echo) or from
stdin when piped. It is **never** taken from a command line argument.

### `init` - create a vault

```bash
python -m pwmgr init
python -m pwmgr --vault ~/work.json init
python -m pwmgr init --force        # overwrite, and accept a weak master password
```

Asks twice, scores the password, and refuses anything below "strong"
unless `--force`. Creates the file at `0600`.

### `add` - add an entry

```bash
python -m pwmgr add GitHub --username octocat --generate --tags dev,work \
                          --url https://github.com
python -m pwmgr add Mail -u me@example.com -p 'chosen-password'
python -m pwmgr add Bank --generate --length 32 --exclude-ambiguous
python -m pwmgr add Work --totp 'JBSW Y3DP EHPK 3PXP'    # TOTP secret
python -m pwmgr add Notes                                # prompts for the rest
```

| Option | Meaning |
|---|---|
| `-u`, `--username` | Username |
| `-p`, `--password` | Password (**avoid on shared machines**: argv is public) |
| `-g`, `--generate` | Generate the password instead |
| `--length N` | Generated length (default 20) |
| `--exclude-ambiguous` | Drop `0O1lI` and friends |
| `--url`, `--notes` | Metadata |
| `--tags a,b,c` | Comma-separated tags |
| `--totp SECRET` | Base32 TOTP secret (spacing/case are normalised) |
| `--show` | Reveal the password in the confirmation output |

### `get` - show one entry

```bash
python -m pwmgr get GitHub              # password masked
python -m pwmgr get GitHub --show       # reveal it
python -m pwmgr get GitHub --copy       # clipboard, auto-cleared after 20s
python -m pwmgr get GitHub --password-only --show   # just the password, for scripts
```

Matches an exact title (case-insensitive) or an entry id; if neither hits,
it falls back to a search and uses a unique match.

### `list` / `search`

```bash
python -m pwmgr list
python -m pwmgr list --tag work
python -m pwmgr list --show             # reveal all passwords - careful
python -m pwmgr search github
python -m pwmgr search example.com
```

`search` covers titles, usernames, URLs, notes and tags. It deliberately
does **not** search password fields.

### `edit` - change an entry

```bash
python -m pwmgr edit GitHub --username new-handle
python -m pwmgr edit GitHub --generate --length 32     # rotate the password
python -m pwmgr edit GitHub --prompt-password          # type a new one, no echo
python -m pwmgr edit GitHub --rename "GitHub (work)"
python -m pwmgr edit GitHub --tags dev,work,2fa        # replaces all tags
python -m pwmgr edit GitHub --totp ''                  # remove the TOTP secret
```

### `remove` - delete an entry

```bash
python -m pwmgr remove OldSite          # asks for confirmation
python -m pwmgr rm OldSite --yes        # scripted
```

### `gen` - generate passwords

```bash
python -m pwmgr gen                                   # 20 chars, all classes
python -m pwmgr gen --length 32 --count 5
python -m pwmgr gen --no-symbols --exclude-ambiguous  # for awkward sites
python -m pwmgr gen --exclude '{}[]'
python -m pwmgr gen --words 6                         # diceware passphrase
python -m pwmgr gen --words 5 --separator ' ' --capitalize --add-number
python -m pwmgr gen --copy
```

Prints the entropy of what it produced, e.g.
`20 chars from an 88-symbol alphabet = 129 bits (very strong)`.
Needs no vault, so it works before `init`.

### `totp` - two-factor codes

```bash
python -m pwmgr totp GitHub             # 6 digits + seconds remaining
python -m pwmgr totp GitHub --copy
```

Add the secret with `add --totp` or `edit --totp`. Codes are RFC 6238 and
verified against the RFC's own test vectors in the test suite. Your system
clock must be roughly correct.

### `audit` - hygiene report

```bash
python -m pwmgr audit
python -m pwmgr audit --stale-days 90
python -m pwmgr audit --strict          # exit non-zero if anything is found
```

Reports **weak** (short, low variety, on the common-password list, keyboard
patterns, sequences, repeats - including leetspeak variants, so
`P@ssw0rd` is caught), **reused** (the same password on more than one
entry, naming the others), **stale** (untouched for over a year), and
**empty** entries. It prints titles and reasons, never password values.

### `export` / `import`

```bash
# Encrypted backup - safe to copy anywhere, opens with the same master password
python -m pwmgr export ~/backup.vault.json

# Plaintext export for migration - loud warning + confirmation required
python -m pwmgr export ~/migrate.json --plaintext
python -m pwmgr export ~/migrate.csv --plaintext --format csv --yes

# Import from another manager's plain export
python -m pwmgr import ~/from-other-manager.csv
python -m pwmgr import ~/dump.json --overwrite --yes
```

Import accepts JSON or CSV (auto-detected) and understands the column names
other managers commonly emit - `name`/`account` for title, `login`/`user`/
`email` for username, `pass`, `website`/`site`, `note`, `otp`/`totp`.
Duplicate titles are skipped unless `--overwrite`. Both plaintext paths
print a red warning and remind you to `shred` the file.

### `change-master`

```bash
python -m pwmgr change-master
```

Prompts for the current password, then the new one twice. Generates a
**fresh salt**, re-derives the key, and re-encrypts the whole vault.
Existing backups still open with the **old** password - the command tells
you so.

### `shell` - interactive session

```bash
python -m pwmgr shell
```

Unlocks once and stays open, so you do not retype the master password:

```
pwmgr> list
pwmgr> search git
pwmgr> get GitHub          # masked
pwmgr> show GitHub         # revealed
pwmgr> copy GitHub         # clipboard, 20s
pwmgr> totp GitHub
pwmgr> add Netflix
pwmgr> remove OldSite
pwmgr> gen 32
pwmgr> audit
pwmgr> lock                # wipe the key and exit
pwmgr> quit
```

Auto-locks after the idle timeout and re-prompts.

---

## Scripting

When stdin is a pipe, the master password is read from it:

```bash
printf 'my-master-password\nmy-master-password\n' | python -m pwmgr init
printf 'my-master-password\n' | python -m pwmgr add CI --generate
printf 'my-master-password\n' | python -m pwmgr get CI --password-only --show
```

Handy for tests and automation. On a real machine, remember that a password
in a script is a password on disk.

Exit codes: `0` success, `1` error (including a wrong master password and
`audit --strict` findings), `2` usage error.

---

## Project layout

```
09-password-manager/
├── pwmgr/
│   ├── crypto.py      Argon2id derivation, AES-256-GCM, AAD, wiping
│   ├── vault.py       file format, atomic writes, backups, locking
│   ├── models.py      Entry / VaultData
│   ├── generator.py   password + diceware passphrase generation
│   ├── totp.py        RFC 4226 HOTP / RFC 6238 TOTP
│   ├── audit.py       strength heuristic, reuse and staleness checks
│   ├── clipboard.py   copy with timed auto-clear
│   ├── cli.py         argparse + rich CLI, and the shell REPL
│   └── data/          wordlist.txt (2000 words), common_passwords.txt
├── tests/             294 pytest tests
├── requirements.txt
├── README.md
└── SECURITY.md
```

## Tests

```bash
python -m pytest tests/ -q
```

Covers encrypt/decrypt round-trips, wrong-password rejection, tampered
header (AAD) and tampered ciphertext rejection, atomic-write and
backup-rotation behaviour, vault file permissions, generator charset and
entropy constraints, the RFC 4226/6238 test vectors, audit detection of
weak and reused passwords, and import/export round-trips through the real
CLI.

## Licence

Provided as-is, for learning. No warranty - see the note at the top.
