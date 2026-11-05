"""End-to-end through real aiogram objects with a fake HTTP session (runs in CI where aiogram is installed)."""
from __future__ import annotations

import asyncio
import json
from datetime import datetime

import pytest

aiogram = pytest.importorskip("aiogram")

from aiogram import Bot  # noqa: E402
from aiogram.client.session.base import BaseSession  # noqa: E402
from aiogram.methods import AnswerCallbackQuery, EditMessageText, SendMessage  # noqa: E402
from aiogram.types import Chat, Message  # noqa: E402

from sync.sync import Syncer  # noqa: E402
from tbl_bot.app import App  # noqa: E402
from tbl_bot.bot import build_dispatcher  # noqa: E402
from tbl_bot.storage.sqlite import SqliteStorage  # noqa: E402

from .fakes import NOW, FakeNotion, seed  # noqa: E402


class FakeSession(BaseSession):
    def __init__(self):
        super().__init__()
        self.sent = []

    async def make_request(self, bot, method, timeout=None):
        self.sent.append(method)
        if isinstance(method, (SendMessage, EditMessageText)):
            chat_id = getattr(method, "chat_id", None) or 1
            return Message(message_id=len(self.sent), date=datetime.now(),
                           chat=Chat(id=int(chat_id), type="private"), text=method.text)
        return True

    async def stream_content(self, *a, **kw):  # pragma: no cover
        raise NotImplementedError

    async def close(self):
        pass


def _update(uid, n, text=None, data=None):
    user = {"id": uid, "is_bot": False, "first_name": "Сергей", "username": "sergey"}
    msg = {"message_id": n, "date": 1762329600, "chat": {"id": uid, "type": "private"}, "from": user}
    if data is None:
        msg["text"] = text
        if text.startswith("/"):
            msg["entities"] = [{"type": "bot_command", "offset": 0, "length": len(text.split()[0])}]
        return {"update_id": n, "message": msg}
    msg["text"] = "card"
    return {"update_id": n, "callback_query": {"id": str(n), "from": user, "chat_instance": "x",
                                               "message": msg, "data": data}}


def test_webhook_flow():
    st = SqliteStorage()
    fn = FakeNotion()
    ids = seed(fn)
    Syncer(fn, st, lambda: NOW).run()
    session = FakeSession()
    bot = Bot("123456:TEST", session=session)
    dp = build_dispatcher(App(st, lambda: NOW))

    async def go():
        from aiogram.types import Update
        for n, kw in enumerate([dict(text="/start"), dict(text="/today"), dict(text="ткань"),
                                dict(data=f"t:take:{ids['t_fabric']}"), dict(data="go:menu")], 1):
            await dp.feed_update(bot, Update.model_validate(_update(1001, n, **kw), context={"bot": bot}))

    asyncio.run(go())
    kinds = [type(m).__name__ for m in session.sent]
    assert kinds.count("SendMessage") >= 3
    assert "AnswerCallbackQuery" in kinds and "EditMessageText" in kinds
    assert st.task(ids["t_fabric"]).assignee_tg == 1001
    today = next(m for m in session.sent if isinstance(m, SendMessage) and "Сводка" in m.text)
    assert today.reply_markup.inline_keyboard


def test_cloud_run_server(monkeypatch):
    from aiohttp.test_utils import TestClient, TestServer

    import server
    from tbl_bot import config
    monkeypatch.setattr(config, "WEBHOOK_SECRET", "s3cret")
    monkeypatch.setattr(config, "CRON_SECRET", "cr0n")
    st = SqliteStorage()
    fn = FakeNotion()
    ids = seed(fn)
    session = FakeSession()
    bot = Bot("123456:TEST", session=session)
    rt = server.Runtime(st=st, sync_st=st, notion=fn, bot=bot, now_fn=lambda: NOW)

    async def go():
        async with TestClient(TestServer(server.make_app(rt))) as c:
            assert (await c.get("/")).status == 200
            r = await c.post("/tg", json=_update(1, 1, text="/start"),
                             headers={"X-Telegram-Bot-Api-Secret-Token": "bad"})
            assert r.status == 403
            assert (await c.post("/cron/tick")).status == 403
            r = await c.post("/cron/tick", headers={"X-Cron-Secret": "cr0n"})
            body = await r.json()
            assert "Задач: 5" in body["sync"] and body["morning"] == 0     # synced; nobody to notify yet
            r = await c.post("/cron/tick", headers={"X-Cron-Secret": "cr0n"})
            assert "morning" not in await r.json()                          # once a day
            h = {"X-Telegram-Bot-Api-Secret-Token": "s3cret"}
            assert (await c.post("/tg", json=_update(1, 2, text="/start"), headers=h)).status == 200
            await c.post("/tg", json=_update(1, 3, data=f"t:take:{ids['t_fabric']}"), headers=h)
            r = await c.post("/cron/setup", headers={"X-Cron-Secret": "cr0n"})
            assert (await r.json())["webhook"].endswith("/tg")

    asyncio.run(go())
    assert st.member(1).admin
    t = st.task(ids["t_fabric"])
    assert t.assignee_tg == 1 and not t.dirty                          # pushed to Notion right away
    assert fn.page(ids["t_fabric"])["properties"]["Статус"]["status"]["name"] == "В работе"
    assert any(type(m).__name__ == "SetWebhook" for m in session.sent)
