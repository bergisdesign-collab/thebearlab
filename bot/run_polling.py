"""Local run without Yandex Cloud: long polling + SQLite (or YDB if YDB_ENDPOINT is set).

    cd bot && pip install -r requirements.txt
    BOT_TOKEN=... python run_polling.py
    # load data from Notion locally:  NOTION_TOKEN=... python -m sync.run_sync

Jobs can be fired by hand:  python run_polling.py --job morning
"""
from __future__ import annotations

import argparse
import asyncio
import logging

from tbl_bot import jobs
from tbl_bot.app import App
from tbl_bot.bot import build_dispatcher, make_bot, send_notices, set_commands
from tbl_bot.storage import open_storage


async def main(job: str = "") -> None:
    st = open_storage()
    bot = make_bot()
    if job:
        await send_notices(bot, jobs.run(job, st))
        await bot.session.close()
        return
    await set_commands(bot)
    await bot.delete_webhook(drop_pending_updates=False)
    await build_dispatcher(App(st)).start_polling(bot)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    p = argparse.ArgumentParser()
    p.add_argument("--job", default="", choices=["", "morning", "evening", "weekly"])
    asyncio.run(main(p.parse_args().job))
