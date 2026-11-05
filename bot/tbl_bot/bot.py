"""aiogram 3 adapter: turns Telegram updates into App calls and App results into messages."""
from __future__ import annotations

import logging
from typing import Optional

from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ChatType, ParseMode
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (BotCommand, CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup,
                           LinkPreviewOptions, Message)

from . import config
from .app import App, Notice, Result, Who

log = logging.getLogger("tbl_bot")

COMMANDS = [
    ("today", "Сводка: прогресс, просрочки, вехи"),
    ("my", "Мои задачи"),
    ("next", "Что делать дальше"),
    ("free", "Свободные задачи"),
    ("tasks", "Задачи по этапам"),
    ("plan", "Роадмап"),
    ("milestones", "Вехи"),
    ("ideas", "Бэклог идей"),
    ("new", "Новая задача"),
    ("find", "Поиск"),
    ("team", "Команда"),
    ("sync", "Синхронизация с Notion"),
    ("help", "Что умеет бот"),
]
ALL_COMMANDS = [c for c, _ in COMMANDS] + ["menu", "bindchat", "unbindchat", "digest", "cancel"]


def make_bot(token: str = "") -> Bot:
    return Bot(token or config.BOT_TOKEN, default=DefaultBotProperties(
        parse_mode=ParseMode.HTML, link_preview=LinkPreviewOptions(is_disabled=True)))


def keyboard(kb) -> Optional[InlineKeyboardMarkup]:
    if not kb:
        return None
    rows = []
    for row in kb:
        r = []
        for b in row:
            if b.url:
                r.append(InlineKeyboardButton(text=b.text, url=b.url))
            else:
                r.append(InlineKeyboardButton(text=b.text, callback_data=b.data[:64]))
        rows.append(r)
    return InlineKeyboardMarkup(inline_keyboard=rows)


def who(user) -> Who:
    name = user.first_name or user.username or str(user.id)
    return Who(id=user.id, name=name, username=user.username or "")


async def send_notices(bot: Bot, notices: list[Notice]) -> None:
    for n in notices:
        try:
            await bot.send_message(n.chat_id, n.text, reply_markup=keyboard(n.kb))
        except TelegramAPIError as e:   # user never opened the bot, blocked it, etc.
            log.warning("notice to %s failed: %s", n.chat_id, e)


def build_dispatcher(app: App) -> Dispatcher:
    router = Router()

    async def deliver(message: Message, res: Optional[Result]) -> None:
        if res is None:
            return
        if res.screen:
            await message.answer(res.screen.text, reply_markup=keyboard(res.screen.kb))
        await send_notices(message.bot, res.notices)

    @router.message(CommandStart())
    async def on_start(message: Message):
        if message.chat.type != ChatType.PRIVATE:
            await message.answer("Напиши мне в личку /start, чтобы попасть в команду.")
            return
        await deliver(message, app.start(who(message.from_user)))

    @router.message(Command(*ALL_COMMANDS))
    async def on_cmd(message: Message, command: CommandObject):
        res = app.on_command(who(message.from_user), message.chat.id,
                             message.chat.type == ChatType.PRIVATE, command.command, command.args or "")
        await deliver(message, res)

    @router.message(F.text & ~F.text.startswith("/"))
    async def on_text(message: Message):
        res = app.on_text(who(message.from_user), message.chat.id,
                          message.chat.type == ChatType.PRIVATE, message.text)
        await deliver(message, res)

    @router.callback_query()
    async def on_cb(cb: CallbackQuery):
        chat_id = cb.message.chat.id if cb.message else cb.from_user.id
        res = app.on_callback(who(cb.from_user), chat_id, cb.data or "")
        await cb.answer(res.toast[:190] if res.toast else None, show_alert=res.alert)
        if res.screen and cb.message:
            kb = keyboard(res.screen.kb)
            if res.new_message:
                await cb.message.answer(res.screen.text, reply_markup=kb)
            else:
                try:
                    await cb.message.edit_text(res.screen.text, reply_markup=kb)
                except TelegramBadRequest as e:
                    if "not modified" not in str(e):
                        await cb.message.answer(res.screen.text, reply_markup=kb)
        await send_notices(cb.bot, res.notices)

    dp = Dispatcher()
    dp.include_router(router)
    return dp


async def set_commands(bot: Bot) -> None:
    await bot.set_my_commands([BotCommand(command=c, description=d) for c, d in COMMANDS])
