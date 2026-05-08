"""FastAPI server that mirrors the metaai_api.api_server contract.

The OpenClaw `metaai` plugin spawns this process via:

    python -m uvicorn metaai_api.api_server:app --host 127.0.0.1 --port <p>

A shim in metaai_api/api_server.py re-exports the ``app`` defined here, so
no plugin code change is required to swap in this Playwright-driven backend.
"""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .browser import session

logging.basicConfig(
    level=os.environ.get("METAAI_PLAYWRIGHT_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("metaai-playwright")

app = FastAPI(
    title="Meta AI Sidecar (Playwright transport)",
    version="0.1.0",
    description=(
        "Drop-in replacement for metaai_api.api_server using a headless "
        "Chromium session against meta.ai instead of the broken GraphQL "
        "persisted-query path."
    ),
)


def _reply_timeout_s() -> int:
    raw = (
        os.environ.get("META_AI_PLAYWRIGHT_REPLY_TIMEOUT")
        or os.environ.get("METAAI_PLAYWRIGHT_REPLY_TIMEOUT")
        or "75"
    )
    try:
        return max(1, int(raw))
    except ValueError:
        return 75


class ChatRequest(BaseModel):
    message: str
    stream: bool = False
    new_conversation: bool = True
    media_ids: list | None = None
    attachment_metadata: dict | None = None
    # The Node sidecar client sometimes sends a `mode` field; accept and ignore.
    mode: str | None = None


class ChatResponse(BaseModel):
    message: str
    sources: list = Field(default_factory=list)
    media: list = Field(default_factory=list)


@app.on_event("startup")
async def _startup() -> None:
    # Start the browser eagerly so the first /chat call has minimal latency.
    # If the cookies are missing this raises and the process exits, matching
    # the upstream FastAPI sidecar's "fail-fast on missing cookies" behaviour.
    try:
        await session.ensure_started()
    except Exception as exc:
        logger.error("metaai-playwright: failed to launch browser: %s", exc)
        # Don't crash the process -- /healthz still answers and the next /chat
        # call will retry. The plugin's startup probe polls /healthz only.


@app.on_event("shutdown")
async def _shutdown() -> None:
    await session.shutdown()


@app.get("/healthz")
async def healthz() -> dict:
    # Always return ok once the FastAPI app is up. The plugin uses this only
    # to verify the HTTP listener is alive; deeper health is exposed via the
    # response code of /chat itself.
    return {
        "status": "ok",
        "transport": "playwright",
        "browser_ready": await session.health(),
    }


@app.post("/chat", response_model=ChatResponse)
async def chat(body: ChatRequest) -> ChatResponse:
    if body.stream:
        # The OpenClaw plugin's metaai-client always sends stream=false; the
        # streaming surface is implemented by the Node OpenAI-compat proxy
        # using the full response from this endpoint.
        raise HTTPException(
            status_code=400,
            detail="Streaming not supported via HTTP JSON; set stream=false",
        )
    if body.media_ids:
        raise HTTPException(
            status_code=501,
            detail="Image/video attachments are not supported by the Playwright sidecar.",
        )
    try:
        text = await session.send_chat(
            body.message,
            new_conversation=body.new_conversation,
            wait_timeout_s=_reply_timeout_s(),
        )
    except Exception as exc:
        logger.exception("metaai-playwright: chat turn failed")
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if not text:
        raise HTTPException(status_code=502, detail="Empty assistant response from meta.ai")
    return ChatResponse(message=text, sources=[], media=[])


# The upstream sidecar exposes /image, /video, /upload — we surface explicit
# 501s so misrouted callers get a clear error instead of 404.
@app.post("/image")
async def image_unsupported() -> dict:
    raise HTTPException(
        status_code=501,
        detail="Image generation is not supported by the Playwright sidecar.",
    )


@app.post("/video")
async def video_unsupported() -> dict:
    raise HTTPException(
        status_code=501,
        detail="Video generation is not supported by the Playwright sidecar.",
    )


@app.post("/upload")
async def upload_unsupported() -> dict:
    raise HTTPException(
        status_code=501,
        detail="Image upload is not supported by the Playwright sidecar.",
    )
