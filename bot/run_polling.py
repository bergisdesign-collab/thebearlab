"""Local run without Google Cloud: long polling + SQLite file, Notion sync and jobs in the background.

    cd bot && pip install -r requirements-dev.txt
    BOT_TOKEN=... NOTION_TOKEN=... python run_polling.py

Fire a job by hand:  python run_polling.py --job morning
"""
from __future__ import annotations

import argparse
import asyncio
import logging

from server import Runtime
from tbl_bot import jobs
from tbl_bot.bot import send_notices, set_commands

log = logging.getLogger("tbl_bot")


async def scheduler(rt: Runtime, every: int = 600) -> None:
    while True:
        try:
            await asyncio.to_thread(rt.full_sync)
            now = rt.now()
            for job in jobs.due(rt.st, now):
                await send_notices(rt.bot, jobs.run(job, rt.st, rt.now))
                jobs.mark_done(rt.st, job, now)
        except Exception:
            log.exception("background tick failed")
        await asyncio.sleep(every)


async def main(job: str = "") -> None:
    rt = Runtime()
    if job:
        await send_notices(rt.bot, jobs.run(job, rt.st))
        await rt.bot.session.close()
        return
    await set_commands(rt.bot)
    await rt.bot.delete_webhook(drop_pending_updates=False)
    asyncio.create_task(scheduler(rt))
    await rt.dp.start_polling(rt.bot)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    p = argparse.ArgumentParser()
    p.add_argument("--job", default="", choices=["", "morning", "evening", "weekly"])
    asyncio.run(main(p.parse_args().job))
