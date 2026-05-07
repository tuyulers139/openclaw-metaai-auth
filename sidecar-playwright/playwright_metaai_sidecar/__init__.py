"""Playwright-driven Meta AI chat sidecar.

Drop-in replacement for `metaai_api.api_server`. Exposes the exact same HTTP
endpoints (``/healthz``, ``/chat``) consumed by the OpenClaw `metaai` plugin,
but instead of POSTing to Meta's broken GraphQL persisted-query, it drives a
real headless Chromium session against ``https://www.meta.ai/`` using the
operator's cookies.
"""

__all__ = ["app"]

from .server import app  # noqa: E402,F401
