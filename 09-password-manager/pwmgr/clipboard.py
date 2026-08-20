"""Clipboard helpers with a timed auto-clear.

The clipboard is shared with every other process on the machine, so a
secret copied here is only as private as the desktop session. We therefore
keep the exposure window short and always try to clear.
"""

from __future__ import annotations

import threading
import time
from typing import Callable, Optional

try:  # pyperclip is optional at import time so tests can run headless
    import pyperclip

    _PYPERCLIP_IMPORT_ERROR: Optional[Exception] = None
except Exception as exc:  # pragma: no cover - only on odd installs
    pyperclip = None  # type: ignore[assignment]
    _PYPERCLIP_IMPORT_ERROR = exc

CLEAR_SECONDS = 20


class ClipboardError(Exception):
    """Raised when no working clipboard backend is available."""


def available() -> bool:
    """True if a clipboard backend actually works on this machine."""
    if pyperclip is None:
        return False
    try:
        pyperclip.paste()
        return True
    except Exception:  # noqa: BLE001 - pyperclip raises many backend errors
        return False


def copy(text: str) -> None:
    """Put ``text`` on the system clipboard."""
    if pyperclip is None:
        raise ClipboardError(
            f"pyperclip is unavailable ({_PYPERCLIP_IMPORT_ERROR}); install it or use --show"
        )
    try:
        pyperclip.copy(text)
    except Exception as exc:  # noqa: BLE001
        raise ClipboardError(
            "no clipboard backend found (on Linux install xclip, xsel or wl-clipboard)"
        ) from exc


def clear(only_if_matches: Optional[str] = None) -> bool:
    """Clear the clipboard.

    With ``only_if_matches`` the clipboard is left alone unless it still
    holds that exact value - so we never wipe something the user copied
    themselves in the meantime. Returns True if it was cleared.
    """
    if pyperclip is None:
        return False
    try:
        if only_if_matches is not None:
            try:
                if pyperclip.paste() != only_if_matches:
                    return False
            except Exception:  # noqa: BLE001 - paste unsupported; clear anyway
                pass
        pyperclip.copy("")
        return True
    except Exception:  # noqa: BLE001
        return False


def copy_with_timeout(
    text: str,
    seconds: int = CLEAR_SECONDS,
    on_clear: Optional[Callable[[], None]] = None,
    block: bool = False,
) -> threading.Thread:
    """Copy ``text``, then clear it after ``seconds``.

    Returns the timer thread. With ``block=False`` (default) the thread is
    non-daemon and joined by :func:`wait_for_clear`, so a short-lived CLI
    process still waits for the wipe rather than exiting with the secret
    left on the clipboard.
    """
    copy(text)

    def _worker() -> None:
        time.sleep(max(0, seconds))
        cleared = clear(only_if_matches=text)
        if on_clear is not None:
            try:
                on_clear()
            except Exception:  # noqa: BLE001 - never let a callback escape
                pass
        del cleared

    thread = threading.Thread(target=_worker, name="pwmgr-clipboard-clear", daemon=False)
    thread.start()
    if block:
        thread.join()
    return thread


def wait_for_clear(thread: Optional[threading.Thread], timeout: Optional[float] = None) -> None:
    """Block until the auto-clear timer has run."""
    if thread is not None and thread.is_alive():
        thread.join(timeout)
