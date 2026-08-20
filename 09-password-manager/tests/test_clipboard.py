"""Clipboard tests using a fake backend (CI has no real clipboard)."""

from __future__ import annotations

import time

import pytest

from pwmgr import clipboard


class FakeClipboard:
    """Stands in for pyperclip."""

    def __init__(self, working: bool = True):
        self.buffer = ""
        self.working = working

    def copy(self, text):
        if not self.working:
            raise RuntimeError("no backend")
        self.buffer = text

    def paste(self):
        if not self.working:
            raise RuntimeError("no backend")
        return self.buffer


@pytest.fixture
def fake(monkeypatch):
    backend = FakeClipboard()
    monkeypatch.setattr(clipboard, "pyperclip", backend)
    return backend


def test_copy_and_clear(fake):
    clipboard.copy("s3cr3t")
    assert fake.buffer == "s3cr3t"
    assert clipboard.clear() is True
    assert fake.buffer == ""


def test_available_reflects_backend(fake, monkeypatch):
    assert clipboard.available() is True
    monkeypatch.setattr(clipboard, "pyperclip", FakeClipboard(working=False))
    assert clipboard.available() is False


def test_copy_raises_when_no_backend(monkeypatch):
    monkeypatch.setattr(clipboard, "pyperclip", FakeClipboard(working=False))
    with pytest.raises(clipboard.ClipboardError, match="clipboard"):
        clipboard.copy("x")


def test_copy_raises_when_pyperclip_missing(monkeypatch):
    monkeypatch.setattr(clipboard, "pyperclip", None)
    with pytest.raises(clipboard.ClipboardError):
        clipboard.copy("x")
    assert clipboard.available() is False
    assert clipboard.clear() is False


def test_auto_clear_after_timeout(fake):
    thread = clipboard.copy_with_timeout("s3cr3t", seconds=0.05)
    assert fake.buffer == "s3cr3t"
    clipboard.wait_for_clear(thread, timeout=2)
    assert fake.buffer == ""


def test_auto_clear_leaves_other_content_alone(fake):
    """If the user copied something else meanwhile, do not wipe it."""
    thread = clipboard.copy_with_timeout("s3cr3t", seconds=0.05)
    fake.buffer = "something the user copied"
    clipboard.wait_for_clear(thread, timeout=2)
    assert fake.buffer == "something the user copied"


def test_clear_only_if_matches(fake):
    fake.buffer = "other"
    assert clipboard.clear(only_if_matches="s3cr3t") is False
    assert fake.buffer == "other"


def test_on_clear_callback_runs(fake):
    called = []
    thread = clipboard.copy_with_timeout("x", seconds=0.01, on_clear=lambda: called.append(True))
    clipboard.wait_for_clear(thread, timeout=2)
    assert called == [True]


def test_callback_errors_do_not_escape(fake):
    def boom():
        raise RuntimeError("callback failed")

    thread = clipboard.copy_with_timeout("x", seconds=0.01, on_clear=boom)
    clipboard.wait_for_clear(thread, timeout=2)
    assert not thread.is_alive()


def test_default_clear_delay_is_twenty_seconds():
    assert clipboard.CLEAR_SECONDS == 20


def test_blocking_mode_waits(fake):
    start = time.monotonic()
    clipboard.copy_with_timeout("x", seconds=0.1, block=True)
    assert time.monotonic() - start >= 0.09
    assert fake.buffer == ""
