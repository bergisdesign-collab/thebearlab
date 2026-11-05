"""HTTP server for Google Cloud Run.

  POST /tg           Telegram webhook (checked with X-Telegram-Bot-Api-Secret-Token)
  POST /cron/tick    every 10 min from Cloud Scheduler: Notion sync + due jobs (09:00 / 18:00 / Fri)
  POST /cron/setup   after each deploy: registers the webhook on this service's URL + bot menu
  GET  /             health check
/cron/* require the X-Cron-Secret header.
"""
from __future__ import annotations

import asyncio
import hmac
import logging
import os
import threading
from typing import Optional

from aiohttp import web
from aiogram.types import Update

from sync.notion_api import NotionClient
from sync.sync import Syncer
from tbl_bot import config, jobs
from tbl_bot.app import App
from tbl_bot.bot import build_dispatcher, make_bot, send_notices, set_commands
from tbl_bot.storage import Storage, open_storage

log = logging.getLogger("tbl_bot")


class Runtime:
    """Everything one Cloud Run instance keeps between requests."""

    def __init__(self, st: Optional[Storage] = None, sync_st: Optional[Storage] = None,
                 notion: Optional[NotionClient] = None, bot=None, now_fn=config.now):
        self.st = st or open_storage()
        # The sync gets its own storage object (own read cache) so it never sees a stale request cache.
        self.sync_st = sync_st or open_storage()
        self.notion = notion or (NotionClient(config.NOTION_TOKEN) if config.NOTION_TOKEN else None)
        self.bot = bot or make_bot()
        self.now = now_fn
        self.sync_lock = threading.Lock()
        self.app = App(self.st, now_fn, sync_fn=self.sync_now if self.notion else None)
        self.dp = build_dispatcher(self.app)

    # --- Notion ---------------------------------------------------------------
    def full_sync(self) -> Optional[str]:
        if not self.notion:
            return None
        with self.sync_lock:
            self.sync_st.begin()
            rep = Syncer(self.notion, self.sync_st, self.now).run()
        for e in rep.errors:
            log.error("sync: %s", e)
        return rep.short()

    def sync_now(self) -> str:
        return self.full_sync() or "Notion не подключён."

    def push_changes(self) -> None:
        if not self.notion or not self.sync_lock.acquire(blocking=False):
            return   # a full sync is running and will push anyway
        try:
            self.sync_st.begin()
            s = Syncer(self.notion, self.sync_st, self.now)
            if s.has_local_changes():
                rep = s.push()
                for e in rep.errors:
                    log.error("push: %s", e)
        finally:
            self.sync_lock.release()


def _ok_secret(got: str, expected: str) -> bool:
    return bool(expected) and hmac.compare_digest(got or "", expected)


def make_app(rt: Optional[Runtime] = None) -> web.Application:
    rt = rt or Runtime()

    async def health(request: web.Request) -> web.Response:
        return web.Response(text="the Bear Lab Bot: ok")

    async def telegram(request: web.Request) -> web.Response:
        if config.WEBHOOK_SECRET and not _ok_secret(
                request.headers.get("X-Telegram-Bot-Api-Secret-Token", ""), config.WEBHOOK_SECRET):
            return web.Response(status=403, text="forbidden")
        data = await request.json()
        rt.st.begin()
        try:
            await rt.dp.feed_update(rt.bot, Update.model_validate(data, context={"bot": rt.bot}))
        except Exception:
            log.exception("update failed")   # still 200, otherwise Telegram retries forever
        try:
            await asyncio.to_thread(rt.push_changes)
        except Exception:
            log.exception("push to Notion failed")
        return web.Response(text="ok")

    async def tick(request: web.Request) -> web.Response:
        if not _ok_secret(request.headers.get("X-Cron-Secret", ""), config.CRON_SECRET):
            return web.Response(status=403, text="forbidden")
        result = {}
        try:
            result["sync"] = await asyncio.to_thread(rt.full_sync)
        except Exception as e:
            log.exception("sync failed")
            result["sync_error"] = str(e)[:300]
        rt.st.begin()
        now = rt.now()
        for job in jobs.due(rt.st, now):
            notices = jobs.run(job, rt.st, rt.now)
            await send_notices(rt.bot, notices)
            jobs.mark_done(rt.st, job, now)
            result[job] = len(notices)
        log.info("tick: %s", result)
        return web.json_response(result)

    async def setup(request: web.Request) -> web.Response:
        if not _ok_secret(request.headers.get("X-Cron-Secret", ""), config.CRON_SECRET):
            return web.Response(status=403, text="forbidden")
        url = f"https://{request.host}/tg"
        await rt.bot.set_webhook(url, secret_token=config.WEBHOOK_SECRET or None,
                                 allowed_updates=["message", "callback_query"])
        await set_commands(rt.bot)
        return web.json_response({"webhook": url})

    app = web.Application()
    app.router.add_get("/", health)
    app.router.add_post("/tg", telegram)
    app.router.add_post("/cron/tick", tick)
    app.router.add_post("/cron/setup", setup)
    app["runtime"] = rt
    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    web.run_app(make_app(), port=int(os.environ.get("PORT", "8080")))
