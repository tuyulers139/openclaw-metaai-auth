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
import logging
import os
import re
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

# Selectors confirmed against meta.ai ~2026-05-07. Adjust if Meta moves the DOM.
COMPOSER_SEL = 'div[data-testid="composer-input"][role="textbox"][contenteditable="true"]'
SEND_BTN_SEL = 'button[aria-label="Send"]'
STOP_BTN_SEL = "button[aria-label*='Stop' i]"
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
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                ],
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

    async def _navigate_home(self) -> None:
        assert self._page is not None
        await self._page.goto(META_AI_URL, timeout=45_000, wait_until="domcontentloaded")
        # Allow rd_challenge JS to run + reload, then settle.
        try:
            await self._page.wait_for_load_state("networkidle", timeout=30_000)
        except PWTimeout:
            logger.warning("networkidle timeout; continuing anyway")
        # Wait for composer to attach (it's a contenteditable div, not the
        # hidden textarea). Visibility is checked separately because the
        # element exists in the DOM before being mounted.
        await self._page.wait_for_selector(COMPOSER_SEL, timeout=20_000, state="visible")

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
        await self._page.wait_for_selector(COMPOSER_SEL, timeout=20_000, state="visible")

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
        composer = await page.wait_for_selector(COMPOSER_SEL, timeout=15_000, state="visible")
        await composer.click()
        await page.keyboard.type(message, delay=5)
        # Tiny settle to let the Send button enable.
        await page.wait_for_timeout(150)

        send_btn = await page.wait_for_selector(SEND_BTN_SEL, timeout=5_000, state="visible")
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
