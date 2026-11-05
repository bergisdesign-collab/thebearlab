"""Yandex Cloud Functions entrypoint: `handler.handler`.

One function serves two kinds of invocations:
  * HTTP (API Gateway / function URL) — Telegram webhook updates;
  * timer triggers — payload "morning" | "evening" | "weekly" | "setup".
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging

from aiogram.types import Update

from tbl_bot import config, jobs
from tbl_bot.app import App
from tbl_bot.bot import build_dispatcher, make_bot, send_notices, set_commands
from tbl_bot.storage import open_storage

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("tbl_bot")

_storage = None


def storage():
    # Reused between warm invocations of the same instance.
    global _storage
    if _storage is None:
        _storage = open_storage()
    return _storage


async def _process_update(data: dict) -> None:
    st = storage()
    bot = make_bot()
    try:
        dp = build_dispatcher(App(st))
        await dp.feed_update(bot, Update.model_validate(data, context={"bot": bot}))
    finally:
        await bot.session.close()


async def _run_job(job: str) -> int:
    st = storage()
    bot = make_bot()
    try:
        if job == "setup":
            if hasattr(st, "ensure_schema"):
                st.ensure_schema()
            await set_commands(bot)
            return 0
        notices = jobs.run(job, st)
        await send_notices(bot, notices)
        return len(notices)
    finally:
        await bot.session.close()


def handler(event, context):
    # --- timer trigger ---
    if isinstance(event, dict) and event.get("messages"):
        payload = event["messages"][0].get("details", {}).get("payload", "")
        sent = asyncio.run(_run_job(payload.strip()))
        log.info("job %s: %s notices", payload, sent)
        return {"statusCode": 200, "body": "ok"}

    # --- Telegram webhook ---
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    if config.WEBHOOK_SECRET and headers.get("x-telegram-bot-api-secret-token") != config.WEBHOOK_SECRET:
        return {"statusCode": 403, "body": "forbidden"}
    body = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode()
    try:
        asyncio.run(_process_update(json.loads(body)))
    except Exception:
        # Answer 200 anyway, otherwise Telegram retries the same update forever.
        log.exception("update failed")
    return {"statusCode": 200, "body": "ok"}
