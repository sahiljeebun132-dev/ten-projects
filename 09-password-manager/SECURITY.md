# Security design

This document describes exactly what pwmgr does with your secrets, so the
design can be checked rather than trusted. It is written to be read
alongside `pwmgr/crypto.py` and `pwmgr/vault.py`.

**This is a learning project. Audit it before trusting it with real secrets.**

---

## 1. Cryptographic construction

### Key derivation: Argon2id

| Parameter | Value | Why |
|---|---|---|
| Algorithm | Argon2id | Winner of the Password Hashing Competition; the hybrid mode resists both GPU/ASIC (data-independent) and side-channel (data-dependent) attacks |
| `time_cost` | 3 | Iteration count |
| `memory_cost` | 65536 KiB (64 MiB) | Memory hardness - the main defence against parallel cracking hardware |
| `parallelism` | 4 | Lanes |
| Output length | 32 bytes | Exactly one AES-256 key |
| Salt | 16 random bytes, per vault | Prevents rainbow tables and cross-vault precomputation |

The salt comes from `secrets.token_bytes` (the OS CSPRNG) and is stored in
the cleartext vault header - a salt is not secret, it only needs to be
unique. The parameters are stored alongside it so a future build can raise
them and still open old vaults.

The master password itself is **never** stored, hashed-for-verification, or
written anywhere. There is no separate "password verifier" field: the only
proof that a password is correct is that AES-GCM authentication succeeds.
That means there is nothing offline-crackable in the file *except* the
vault body itself.

### Body encryption: AES-256-GCM

* AES-256 in Galois/Counter Mode, via `cryptography.hazmat` (which is
  backed by OpenSSL). No cryptographic primitive is hand-rolled.
* A **fresh random 12-byte nonce on every single write**. 12 bytes is the
  GCM-native size, so no nonce rehashing occurs. Nonce reuse under the same
  key is catastrophic for GCM, so nonces are never derived from a counter
  or from the plaintext - they are always random, and a new one is
  generated on every save (verified by `test_each_write_uses_a_fresh_nonce`
  and `test_each_save_rotates_the_nonce`).
* GCM is an AEAD: it provides confidentiality **and** integrity. A modified
  ciphertext does not decrypt to garbage, it fails to authenticate.

### Header authentication (AAD)

The vault header - format magic, version, KDF name and parameters, salt,
cipher name, creation time - is not encrypted (it is needed *before* the
key exists), but it **is** authenticated. Its canonical serialisation
(`json.dumps(header, sort_keys=True, separators=(",", ":"))`) is passed to
AES-GCM as Additional Authenticated Data.

This closes a real attack: without it, an attacker with write access to the
file could lower `memory_cost` to 8 KiB, wait for you to unlock, and have
your key derived with a KDF weak enough to brute-force. With the header as
AAD, any edit to any header field makes decryption fail outright. See
`test_tampered_header_aad_is_rejected` and `test_tampered_header_in_file_is_rejected`.

Because the AAD is *canonical* (sorted keys, no whitespace), reformatting
the JSON file is harmless while changing its content is not.

### File format

```jsonc
{
  "header": {                       // authenticated as AAD, not encrypted
    "format": "pwmgr-vault",
    "version": 1,                   // for future migrations
    "kdf": { "name": "argon2id", "time_cost": 3,
             "memory_cost": 65536, "parallelism": 4, "key_len": 32 },
    "salt": "<base64, 16 bytes>",
    "cipher": "aes-256-gcm",
    "created_at": "2026-01-01T00:00:00Z"
  },
  "nonce": "<base64, 12 bytes>",
  "ciphertext": "<base64: AES-256-GCM output, 16-byte tag appended>"
}
```

Everything sensitive - titles, usernames, passwords, URLs, notes, tags,
TOTP secrets, timestamps - lives inside the ciphertext. The header leaks
only that a pwmgr vault exists and roughly how large it is.

`version` is checked on open; an unknown version is refused rather than
guessed at.

---

## 2. Failing closed

Decryption failures all raise the same `DecryptionError` with the same
message:

```
wrong master password or corrupted vault
```

A wrong password, a flipped ciphertext bit, an edited header, a truncated
file, and a body that authenticates but is not valid JSON are deliberately
**indistinguishable**. Telling the user "the password was right but the
file is corrupt" would confirm a guessed password to an attacker holding a
stolen vault file. `test_decryption_error_message_does_not_leak_the_cause`
pins this behaviour.

Nothing is ever decrypted "partially". There is no path that returns
plaintext when authentication fails.

---

## 3. Storage integrity

### Atomic writes

A save never truncates the live vault. `atomic_write`:

1. creates a temp file in the **same directory** (same filesystem, so the
   rename is atomic),
2. writes and `fsync`s it,
3. `chmod`s it to `0600` *before* it is visible under the real name,
4. `os.replace`s it over the target (atomic on POSIX and on Windows),
5. `fsync`s the directory so the rename itself survives a crash,
6. deletes the temp file if anything above failed.

At no point does a reader see a half-written vault, and a crash mid-save
leaves the previous vault intact (`test_atomic_write_leaves_original_intact_on_failure`).

### Backups

Before every write, the current vault is copied to
`<vault-dir>/backups/<name>.<UTC timestamp>.bak` and the **5 most recent**
are kept. Backups are ciphertext, mode `0600`, and open with whatever
master password was in force when they were made.

> After `change-master`, existing backups still require the **old**
> password. The CLI says so explicitly. Delete them if the old password is
> considered compromised.

### Permissions

* Vault file: `0600` (owner read/write only)
* Vault directory and `backups/`: `0700`
* Plaintext exports: created with `os.open(..., 0o600)` so they are never
  even briefly world-readable

Permissions are re-applied on every write, so a stray `chmod 644` is
corrected on the next save.

---

## 4. Secrets in memory

CPython gives no way to guarantee a secret is gone from RAM: `str` and
`bytes` are immutable and may be interned, copied by the GC, or paged to
swap. pwmgr does what is possible rather than pretending the problem is
solved:

* The derived key lives in a `bytearray` and is overwritten byte-by-byte by
  `crypto.wipe()` on lock, on context-manager exit, and after a master
  password change.
* `derive_key` encodes the password into a temporary `bytearray` and wipes
  that buffer in a `finally` block.
* `Vault.lock()` wipes the key **and** drops all decrypted entries.
* The serialised plaintext body is held in a `bytearray` and wiped after
  encryption.
* `Vault` is a context manager so `with` guarantees the wipe even on an
  exception.

**Known limitation:** the master password arrives from `getpass`/stdin as
an immutable `str`. That copy cannot be wiped. Only the OS can fix that
(memory locking, no swap, encrypted swap).

---

## 5. Exposure controls

### Auto-lock

The vault tracks its last activity on a monotonic clock and locks after N
idle minutes (default 5, `--autolock 0` disables). Locking wipes the key
and clears entries; the shell then re-prompts. Because the timer is
monotonic, changing the system clock cannot extend a session.

### Clipboard

`get --copy` puts the password on the system clipboard and clears it after
**20 seconds**. The clearing thread is non-daemon and is joined before the
process exits, so a short-lived CLI run cannot leave a secret behind. The
clear is conditional: if the clipboard no longer holds *our* value (the
user copied something else meanwhile), it is left alone.

The clipboard is readable by every process in your desktop session and is
often synced to other devices. Prefer `--copy` over `--show` in public, but
understand that neither is private on a compromised machine.

### argv and logging

* The master password is **never** accepted as a command line argument -
  argv is world-readable via `/proc` and lands in shell history.
* `--password` exists for scripted entry passwords and is documented as
  unsafe on shared machines.
* Nothing is logged. There is no log file, no telemetry, no network code of
  any kind. `audit` prints entry titles and problem descriptions, never
  password values.
* `search` matches titles, usernames, URLs, notes and tags - never password
  or TOTP fields, so a bystander cannot confirm a guessed password.

---

## 6. Other constant-time and correctness notes

* Master password confirmation and the "new password differs from old"
  check use `hmac.compare_digest`.
* TOTP verification compares with `hmac.compare_digest` and evaluates
  **every** step in the window without an early `break`, so the runtime
  does not reveal which step matched.
* All randomness - salts, nonces, generated passwords, passphrase words,
  TOTP secrets, the generator's Fisher-Yates shuffle - comes from
  `secrets`/`os.urandom`. The `random` module is never imported
  (`test_generator_never_imports_the_random_module`).
* Password generation with a required character class draws one mandatory
  character per class then shuffles, rather than rejection-sampling until a
  pattern matches - this preserves uniformity and does not leak timing.

---

## 7. Threat model

### Defends against

| Threat | How |
|---|---|
| Stolen vault file / lost laptop (powered off) | Argon2id + AES-256-GCM; 64 MiB per guess makes offline cracking expensive |
| Cloud-sync or backup exposure | Only ciphertext is written; sync services see opaque bytes |
| Silent tampering with the vault | GCM tag over the body, header as AAD |
| KDF downgrade attack | KDF parameters are authenticated |
| Password-guess confirmation via error messages | Single opaque failure message |
| Other local users reading the file | `0600` file / `0700` directory |
| Corruption or crash during save | Atomic replace + 5 rotating backups |
| Password reuse and weak passwords | `audit` |
| Shoulder-surfing | Masked output by default, `--copy` with a 20s auto-clear |
| Walking away from an unlocked session | Idle auto-lock |
| Nonce reuse | Fresh random 12-byte nonce per write |

### Does NOT defend against

| Threat | Why not |
|---|---|
| **A compromised machine** | This is the big one. Malware running as your user can read the vault file, your keystrokes, the clipboard, and pwmgr's process memory. No user-space password manager survives this. |
| **Keyloggers** | The master password is typed. A keylogger gets it, and then everything. |
| **Memory scraping / cold boot** | Key material is wiped on lock, but while unlocked it is in RAM and may reach swap. Use full-disk encryption and disable or encrypt swap. |
| **A weak master password** | 64 MiB per guess raises the cost of a dictionary attack, it does not eliminate it. `password1` is crackable no matter what the KDF is. `init` enforces a minimum strength for this reason. |
| **Root / another admin on the machine** | Root can read any process's memory. |
| **Physical coercion, phishing, shoulder-surfing your typing** | Out of scope for software. |
| **Metadata concealment** | The header reveals that a vault exists, when it was created, and roughly how many entries it holds (from the file size). Contents are hidden; existence is not. |
| **Forensic recovery of old plaintext exports** | `export --plaintext` writes real passwords to disk. Deleting the file does not erase it from an SSD. Use `shred` and understand its limits. |
| **Untrusted import files** | An import file is parsed as JSON/CSV; treat its origin as you would any other untrusted data. |
| **Lost master password** | There is no recovery, no backdoor, no reset. That is the point. If you lose it, the vault is gone. |

### Explicit non-goals

No network sync, no browser integration, no cloud accounts, no telemetry,
no autofill, no plugin system. Every one of those is an attack surface this
project does not want.

---

## 8. Recommendations

1. Use a **passphrase** as your master password - `pwmgr gen --words 6`
   gives ~66 bits from the bundled 2000-word list. Write it down and store
   it physically, or memorise it.
2. Turn on full-disk encryption. This design assumes the disk may be
   stolen; it assumes the running machine is trusted.
3. Back up the vault file itself (it is ciphertext, so backing it up
   anywhere is safe) - and remember the master password separately.
4. Run `pwmgr audit` periodically.
5. Do not use `export --plaintext` unless you are migrating, and `shred`
   the file immediately afterwards.
6. Prefer `--copy` to `--show`.
7. If you suspect the machine is compromised, changing the master password
   does not help. Rotate the credentials themselves, from a clean machine.
