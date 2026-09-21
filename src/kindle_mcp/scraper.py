"""Playwright access to the Kindle notebook, using a browser profile the user logged into by hand.

This module never sees or stores the Amazon password. `login()` opens a real browser
window; the user signs in (including 2FA) and the session cookies persist in
~/.kindle-mcp/browser-profile for later headless runs.
"""
from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Iterator

from . import notebook_selectors as S
from .config import Config
from .models import Book, Highlight
from .notebook_parser import parse_annotations, parse_library


class AuthRequired(RuntimeError):
    """The saved Amazon session is missing or expired."""

    def __init__(self) -> None:
        super().__init__(
            "Amazon session missing or expired. Run `kindle-mcp login` in a terminal, sign in in the "
            "browser window that opens, then retry the sync."
        )


class NotebookClient:
    def __init__(self, page, cfg: Config):
        self.page, self.cfg = page, cfg

    def _get(self, url: str) -> str:
        self.page.goto(url, wait_until="domcontentloaded")
        if any(marker in self.page.url for marker in S.SIGNIN_URL_MARKERS):
            raise AuthRequired()
        time.sleep(self.cfg.request_delay_s)      # be a polite, low-volume client
        return self.page.content()

    def library(self) -> list[Book]:
        books, token, seen = [], "", set()
        while True:
            page_books, token = parse_library(self._get(S.library_url(self.cfg.notebook_base, token)))
            books += [b for b in page_books if b.book_id not in seen]
            seen.update(b.book_id for b in page_books)
            if not token or not page_books:
                return books

    def annotations(self, asin: str) -> list[Highlight]:
        out, token, state = [], "", ""
        for _ in range(200):                       # hard stop against a pagination loop
            url = S.annotations_url(self.cfg.notebook_base, asin, token, state)
            page_items, token, state = parse_annotations(self._get(url), asin)
            out += page_items
            if not token:
                break
        return out

    def dump(self, asin: str | None = None) -> str:
        url = S.annotations_url(self.cfg.notebook_base, asin) if asin else S.library_url(self.cfg.notebook_base)
        return self._get(url)


@contextmanager
def notebook_session(cfg: Config, headless: bool = True) -> Iterator[NotebookClient]:
    from playwright.sync_api import sync_playwright

    cfg.ensure_dirs()
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(str(cfg.browser_profile), headless=headless)
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            yield NotebookClient(page, cfg)
        finally:
            ctx.close()


def login(cfg: Config, timeout_s: int = 600) -> bool:
    """Open a visible browser and wait for the user to finish signing in."""
    from playwright.sync_api import TimeoutError as PWTimeout, sync_playwright

    cfg.ensure_dirs()
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(str(cfg.browser_profile), headless=False)
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto(S.library_url(cfg.notebook_base))
            page.wait_for_selector(S.LIBRARY_ROOT, timeout=timeout_s * 1000)
            return True
        except PWTimeout:
            return False
        finally:
            ctx.close()
