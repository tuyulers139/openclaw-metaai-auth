"""Persistent Playwright session against https://www.meta.ai/.

Single browser/context/page is held for the lifetime of the process. The
existing OpenClaw plugin already manages the parent process lifecycle (idle
shutdown, SIGTERM on stop), so we don't need our own idle timer here.

Concurrency: one chat at a time. ``send_chat`` acquires an asyncio.Lock so
overlapping `/chat` calls are serialised. Meta's web UI is also single-turn
per conversation, so this matches reality.
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import logging
import os
import re
from pathlib import Path
from typing import Optional

from playwright.async_api import (
    Browser,
    BrowserContext,
    Page,
    async_playwright,
    Playwright,
    TimeoutError as PWTimeout,
)

logger = logging.getLogger(__name__)

META_AI_URL = "https://www.meta.ai/"

# Selectors confirmed against meta.ai ~2026-05-07/08. Meta varies between a
# rich contenteditable composer (logged-in users, certain locales) and a plain
# <input type="text"> (unauth landing, recent rollouts). Both are tried.
COMPOSER_CANDIDATES: tuple[str, ...] = (
    'div[data-testid="composer-input"][role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'input[type="text"][placeholder*="Ask Meta AI" i]',
    'textarea[placeholder*="Ask Meta AI" i]',
)
COMPOSER_SEL = COMPOSER_CANDIDATES[0]
# If this selector matches the page, the user is not logged in and chat
# features are degraded (no auth-only models, possible rate limits).
LOGIN_REQUIRED_SEL = '[data-testid="login-button"]'
# Candidate Send-button selectors, tried in order. Meta varies the aria-label
# by locale and occasionally A/B-tests the button (icon-only vs labeled).
SEND_BTN_CANDIDATES: tuple[str, ...] = (
    'button[aria-label="Send"]',
    'button[aria-label="Send Message"]',
    'button[aria-label*="Send" i]',
    'button[data-testid="send-button"]',
    'form button[type="submit"]:not([disabled])',
    'div[data-testid="composer-input"] ~ button',
)
# Backwards-compat alias (kept for any external callers/tests that import it).
SEND_BTN_SEL = SEND_BTN_CANDIDATES[0]
STOP_BTN_SEL = "button[aria-label*='Stop' i]"

DEBUG_DIR = Path(os.environ.get("META_AI_DEBUG_DIR", "/tmp/metaai-playwright-debug"))
HEADLESS = os.environ.get("META_AI_HEADLESS", "1") not in ("0", "false", "False", "")
SEND_TIMEOUT_MS = int(os.environ.get("META_AI_SEND_TIMEOUT_MS", "8000"))
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)


def _required_env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        raise RuntimeError(
            f"Missing required cookie env var: {name}. Set META_AI_DATR + "
            f"META_AI_ECTO_1_SESS (and optionally META_AI_ABRA_SESS) in the "
            f"environment of the sidecar process."
        )
    return val


def _build_cookies() -> list[dict]:
    datr = _required_env("META_AI_DATR")
    ecto = _required_env("META_AI_ECTO_1_SESS")
    abra = os.environ.get("META_AI_ABRA_SESS", "").strip()
    cookies = [
        {"name": "datr", "value": datr, "domain": ".meta.ai", "path": "/",
         "secure": True, "httpOnly": True, "sameSite": "Lax"},
        {"name": "ecto_1_sess", "value": ecto, "domain": ".meta.ai", "path": "/",
         "secure": True, "httpOnly": True, "sameSite": "Lax"},
    ]
    if abra:
        cookies.append({
            "name": "abra_sess", "value": abra, "domain": ".meta.ai", "path": "/",
            "secure": True, "httpOnly": True, "sameSite": "Lax",
        })
    return cookies


class BrowserSession:
    """Holds a single Chromium / context / page and serialises chat turns."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._init_lock = asyncio.Lock()
        self._pw: Optional[Playwright] = None
        self._browser: Optional[Browser] = None
        self._ctx: Optional[BrowserContext] = None
        self._page: Optional[Page] = None
        self._ready = False

    async def ensure_started(self) -> None:
        if self._ready:
            return
        async with self._init_lock:
            if self._ready:
                return
            logger.info("metaai-playwright: starting Chromium…")
            self._pw = await async_playwright().start()
            self._browser = await self._pw.chromium.launch(
                headless=HEADLESS,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                ],
            )
            logger.info(
                "metaai-playwright: chromium launched (headless=%s, debug_dir=%s)",
                HEADLESS,
                DEBUG_DIR,
            )
            self._ctx = await self._browser.new_context(
                viewport={"width": 1280, "height": 900},
                user_agent=USER_AGENT,
                locale="en-US",
            )
            await self._ctx.add_cookies(_build_cookies())
            self._page = await self._ctx.new_page()
            await self._navigate_home()
            self._ready = True
            logger.info("metaai-playwright: ready")

    async def shutdown(self) -> None:
        try:
            if self._ctx is not None:
                await self._ctx.close()
        except Exception:
            pass
        try:
            if self._browser is not None:
                await self._browser.close()
        except Exception:
            pass
        try:
            if self._pw is not None:
                await self._pw.stop()
        except Exception:
            pass
        self._ready = False

    async def health(self) -> bool:
        return bool(self._ready and self._page and not self._page.is_closed())

    async def _dump_debug(self, label: str) -> Optional[Path]:
        """Save screenshot + DOM HTML when a selector wait fails.

        Returns the directory written to (or None on failure). Cookies and
        secrets are not present in screenshots/DOM dumps from meta.ai's chat
        surface; the dump is purposely shallow (no localStorage / cookies).
        """
        if self._page is None:
            return None
        try:
            DEBUG_DIR.mkdir(parents=True, exist_ok=True)
            ts = _dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
            slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", label).strip("-") or "dump"
            sub = DEBUG_DIR / f"{ts}-{slug}"
            sub.mkdir(parents=True, exist_ok=True)
            await self._page.screenshot(path=str(sub / "page.png"), full_page=True)
            html = await self._page.content()
            (sub / "page.html").write_text(html, encoding="utf-8")
            url = self._page.url
            (sub / "url.txt").write_text(url + "\n", encoding="utf-8")
            logger.warning("metaai-playwright: debug dump written to %s", sub)
            return sub
        except Exception as exc:  # noqa: BLE001
            logger.error("metaai-playwright: debug dump failed: %s", exc)
            return None

    async def _check_login_state(self) -> bool:
        """Return True if the page indicates the user is NOT logged in.

        Meta AI renders a 'Log in / Sign up' CTA when cookies are invalid or
        expired. Detecting this early gives a clear error rather than a
        misleading 'composer not found' timeout.
        """
        if self._page is None:
            return False
        try:
            el = await self._page.query_selector(LOGIN_REQUIRED_SEL)
            return el is not None
        except Exception:  # noqa: BLE001
            return False

    async def _wait_for_composer(self, timeout_ms: int = 20_000):
        """Try each composer candidate; return the first visible match.

        Raises a clear RuntimeError when the page is the unauth landing
        (login button present), so operators see 'cookies invalid' instead
        of a generic Playwright timeout.
        """
        assert self._page is not None
        page = self._page
        per_candidate_ms = max(1500, timeout_ms // max(1, len(COMPOSER_CANDIDATES)))
        last_exc: Optional[Exception] = None
        for sel in COMPOSER_CANDIDATES:
            try:
                el = await page.wait_for_selector(
                    sel, timeout=per_candidate_ms, state="visible"
                )
                if el is not None:
                    logger.info("metaai-playwright: composer matched selector %r", sel)
                    return el
            except PWTimeout as exc:
                last_exc = exc
                continue
        # No composer found — figure out why before raising.
        if await self._check_login_state():
            await self._dump_debug("login-required")
            raise RuntimeError(
                "Meta AI page shows login CTA — cookies (META_AI_DATR / "
                "META_AI_ECTO_1_SESS / optionally META_AI_ABRA_SESS) are "
                "invalid or expired. Re-capture from a logged-in browser."
            )
        await self._dump_debug("composer-not-found")
        raise last_exc or PWTimeout(
            f"Composer not found via any of {len(COMPOSER_CANDIDATES)} selectors"
        )

    async def _wait_for_send_button(self, timeout_ms: int = SEND_TIMEOUT_MS):
        """Try each Send-button candidate; return the first visible match.

        Raises PWTimeout if none match. Dumps debug artefacts on failure.
        """
        assert self._page is not None
        page = self._page
        per_candidate_ms = max(500, timeout_ms // max(1, len(SEND_BTN_CANDIDATES)))
        last_exc: Optional[Exception] = None
        for sel in SEND_BTN_CANDIDATES:
            try:
                el = await page.wait_for_selector(
                    sel, timeout=per_candidate_ms, state="visible"
                )
                if el is not None:
                    logger.info("metaai-playwright: send-button matched selector %r", sel)
                    return el
            except PWTimeout as exc:
                last_exc = exc
                continue
        await self._dump_debug("send-button-not-found")
        raise last_exc or PWTimeout(
            f"Send button not found via any of {len(SEND_BTN_CANDIDATES)} selectors"
        )

    async def _navigate_home(self) -> None:
        assert self._page is not None
        await self._page.goto(META_AI_URL, timeout=45_000, wait_until="domcontentloaded")
        # Allow rd_challenge JS to run + reload, then settle.
        try:
            await self._page.wait_for_load_state("networkidle", timeout=30_000)
        except PWTimeout:
            logger.warning("networkidle timeout; continuing anyway")
        # Wait for composer to attach. Meta varies between contenteditable
        # div (logged-in) and plain <input> (unauth landing); _wait_for_composer
        # tries all candidates and detects login-required state.
        await self._wait_for_composer(timeout_ms=20_000)

    async def _start_new_conversation(self) -> None:
        """Force a fresh chat by reloading the home route.

        meta.ai's SPA does not expose a stable 'New chat' selector across
        regions. Reloading ``/`` consistently drops the previous conversation
        from the active page state; if a redirect to the last conversation
        happens we re-navigate explicitly.
        """
        assert self._page is not None
        await self._page.goto(META_AI_URL, timeout=45_000, wait_until="domcontentloaded")
        try:
            await self._page.wait_for_load_state("networkidle", timeout=20_000)
        except PWTimeout:
            pass
        await self._wait_for_composer(timeout_ms=20_000)

    async def send_chat(
        self,
        message: str,
        *,
        new_conversation: bool = True,
        wait_timeout_s: int = 120,
    ) -> str:
        if not message or not message.strip():
            raise ValueError("message must be non-empty")
        await self.ensure_started()
        assert self._page is not None
        async with self._lock:
            return await self._send_chat_locked(
                message, new_conversation=new_conversation, wait_timeout_s=wait_timeout_s
            )

    async def _send_chat_locked(
        self, message: str, *, new_conversation: bool, wait_timeout_s: int
    ) -> str:
        page = self._page
        assert page is not None

        if new_conversation:
            await self._start_new_conversation()

        # Snapshot body text so we can diff after the response arrives.
        before_text: str = await page.evaluate("() => document.body.innerText")

        # Focus composer and type. We type with `keyboard.type` rather than
        # `fill` because the composer is a contenteditable rich-text field;
        # `fill` does not always trigger React's input handlers.
        composer = await self._wait_for_composer(timeout_ms=15_000)
        await composer.click()
        await page.keyboard.type(message, delay=5)
        # Tiny settle to let the Send button enable.
        await page.wait_for_timeout(250)

        send_btn = await self._wait_for_send_button()
        if not await send_btn.is_enabled():
            # Some long inputs need a beat for the validation pass.
            await page.wait_for_timeout(500)
        await send_btn.click()

        # Streaming detection: the Stop button appears while the response is
        # being generated, then disappears when finished.
        stop_appeared = False
        try:
            await page.wait_for_selector(STOP_BTN_SEL, timeout=15_000, state="visible")
            stop_appeared = True
        except PWTimeout:
            # Very short replies can finish before Stop renders; fall through.
            pass

        if stop_appeared:
            deadline = wait_timeout_s
            for _ in range(deadline):
                el = await page.query_selector(STOP_BTN_SEL)
                if el is None or not await el.is_visible():
                    break
                await page.wait_for_timeout(1000)

        # Allow a final tick for any tail tokens to commit to the DOM.
        await page.wait_for_timeout(800)

        after_text: str = await page.evaluate("() => document.body.innerText")
        return self._diff_assistant_reply(before_text, after_text, message)

    @staticmethod
    def _diff_assistant_reply(before: str, after: str, message: str) -> str:
        """Extract the new assistant text after the user's message.

        meta.ai re-renders the whole conversation; we anchor on the user
        message and take everything that appears between it and the trailing
        UI chrome (composer placeholder, command palette, etc.).
        """
        msg_idx = after.rfind(message.strip())
        if msg_idx < 0:
            # Fallback: pure delta
            extra = after[len(before):].strip()
            return _strip_ui_chrome(extra)

        tail = after[msg_idx + len(message.strip()):]
        return _strip_ui_chrome(tail)


# ---------------------------------------------------------------------------
# UI-chrome filter. Lines we know are page chrome rather than assistant text.
# ---------------------------------------------------------------------------

_CHROME_LINES = {
    "Today",
    "Yesterday",
    "Ask Meta AI...",
    "Thinking",
    "Command Palette",
    "Search for a command to run...",
    "Send",
    "Add attachment",
    "More options",
    "Toggle Sidebar",
    "Dismiss",
    "Connect",
    "Learn and grow",
    "Analyze for me",
    "Create image",
    "Create video",
    "Explain a diagram",
    "Describe what's happening in an image",
    "Debug my code",
    "Highlight insights from a report",
}

_CHROME_PREFIXES = (
    "Search\n",
    "Ctrl+",
    "Edit message",
    "Regenerate",
    "Copy",
    "Like",
    "Dislike",
    "Share",
)


def _strip_ui_chrome(text: str) -> str:
    """Remove conversation-chrome lines from a body-innerText slice."""
    lines = [ln.rstrip() for ln in text.split("\n")]
    out: list[str] = []
    for ln in lines:
        s = ln.strip()
        if not s:
            if out and out[-1] != "":
                out.append("")
            continue
        if s in _CHROME_LINES:
            continue
        if any(s.startswith(p) for p in _CHROME_PREFIXES):
            continue
        # Drop date-stamp lines like "Today" already in the set; also drop
        # very short single-emoji UI bits we can't classify.
        if re.fullmatch(r"\s*[•·]\s*", s):
            continue
        out.append(s)
    # Trim leading/trailing blank lines.
    while out and out[0] == "":
        out.pop(0)
    while out and out[-1] == "":
        out.pop()
    return "\n".join(out).strip()


# Module-level singleton so the FastAPI app and uvicorn workers share state.
session = BrowserSession()
