"""Bot brain, independent of Telegram library.

Input: commands, callback data, free text. Output: `Result` (screen to show + notices to send).
`bot.py` adapts this to aiogram; tests drive it directly.
"""
from __future__ import annotations

import json
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from html import escape as esc
from typing import Callable, Optional

from . import config, logic, texts
from .ai import AIClient
from .models import DONE, PRIORITIES, STAGES, STATUSES, Idea, Member, Task
from .service import ActionError, Service
from .storage import Storage


@dataclass
class Btn:
    text: str
    data: str = ""
    url: str = ""


@dataclass
class Screen:
    text: str
    kb: list = field(default_factory=list)   # list[list[Btn]]


@dataclass
class Notice:
    chat_id: int
    text: str
    kb: list = field(default_factory=list)


@dataclass
class Result:
    screen: Optional[Screen] = None
    notices: list = field(default_factory=list)
    toast: str = ""
    alert: bool = False
    new_message: bool = False     # callbacks: send a new message instead of editing


@dataclass
class Who:
    id: int
    name: str
    username: str = ""


STATUS_BTN = {"Не начато": "⚪ Не начато", "В работе": "🔵 В работу", "На проверке": "🟡 На проверку", "Готово": "✅ Готово"}
BROADCAST_ICON = {"take": "🙋", "release": "↩️", "assign": "👥", "done": "✅", "status": "🔄",
                  "due": "📅", "create": "➕", "result": "🔗"}

MENU = [[Btn("Сводка", "go:today"), Btn("Мои", "go:my"), Btn("Что дальше", "go:next")],
        [Btn("Свободные", "go:free"), Btn("Этапы", "go:tasks"), Btn("Роадмап", "go:plan")],
        [Btn("Идеи", "go:ideas"), Btn("Новая задача", "go:new"), Btn("Команда", "go:team")]]


class App:
    def __init__(self, st: Storage, now_fn: Callable[[], datetime] = config.now, ai: Optional[AIClient] = None):
        self.st = st
        self.now = now_fn
        self.svc = Service(st, now_fn)
        self.ai = ai or AIClient()

    def today(self) -> date:
        return self.now().date()

    # =====================================================================
    # membership
    # =====================================================================
    def _member(self, who: Who) -> Optional[Member]:
        m = self.st.member(who.id)
        if not m or not m.approved:
            return None
        if (who.username or "") != m.username:
            m.username = who.username or ""
            self.st.save_member(m)
        return m

    def _admins(self) -> list[Member]:
        return [m for m in self.st.members() if m.admin and m.approved]

    def start(self, who: Who) -> Result:
        m = self.st.member(who.id)
        if m and m.approved:
            return Result(Screen(f"С возвращением, {esc(m.name)}!\n\n" + texts.HELP, MENU))
        members = [x for x in self.st.members() if x.approved]
        first = not members
        if first or who.id in config.ADMIN_IDS:
            m = Member(tg_id=who.id, name=who.name, username=who.username or "", approved=True, admin=True)
            self.st.save_member(m)
            return Result(Screen(
                f"Привет, {esc(who.name)}! Ты администратор команды.\n\n"
                "Дальше: добавь бота в общий чат и отправь там /bindchat, "
                "а партнёрам дай ссылку на бота — их заявки придут тебе.\n"
                "В /team привяжи себя к пользователю Notion, чтобы назначения попадали в Notion.\n\n" + texts.HELP,
                MENU))
        if not m:
            m = Member(tg_id=who.id, name=who.name, username=who.username or "")
            self.st.save_member(m)
        uname = f" (@{esc(who.username)})" if who.username else ""
        notices = [Notice(a.tg_id, f"Заявка в команду: <b>{esc(who.name)}</b>{uname}",
                          [[Btn("✅ Принять", f"m:ok:{who.id}"), Btn("✖️ Отклонить", f"m:no:{who.id}")]])
                   for a in self._admins()]
        return Result(Screen("Заявка отправлена администратору. Как только её примут, я пришлю сообщение."),
                      notices)

    # =====================================================================
    # entry points
    # =====================================================================
    def on_command(self, who: Who, chat_id: int, private: bool, cmd: str, args: str = "") -> Result:
        self.svc.recent = []
        cmd = cmd.lower().split("@")[0]
        if cmd == "start":
            return self.start(who)
        m = self._member(who)
        if not m:
            return Result(Screen("Сначала отправь мне /start в личных сообщениях — я передам заявку администратору."))
        self.st.delete("kv", f"await:{m.tg_id}")
        args = (args or "").strip()

        if cmd == "bindchat":
            if private:
                return Result(Screen("Отправь /bindchat в общем чате команды — туда будут приходить сводки."))
            if not m.admin:
                return Result(Screen("Привязать чат может только администратор."))
            self.st.kv_set("group_chat", chat_id)
            return Result(Screen("Готово! Сюда будут приходить: сводка в 09:00, вечерняя сверка в 18:00, "
                                 "итоги недели в пятницу и все взятия/снятия/закрытия задач."))
        if cmd == "unbindchat" and m.admin:
            self.st.delete("kv", "group_chat")
            return Result(Screen("Чат отвязан от сводок."))
        if cmd in ("digest", "today"):
            return Result(self.scr_today(m))
        if cmd == "new":
            if args:
                self.st.kv_set(f"await:{m.tg_id}", {"a": "new", "title": args[:200]})
                return Result(self.scr_new_stage(args))
            self.st.kv_set(f"await:{m.tg_id}", {"a": "new_title"})
            return Result(Screen("Как назовём задачу? Напиши одной строкой.", [[Btn("Отмена", "n:cancel")]]))
        if cmd == "find":
            return Result(self.scr_search(args) if args else Screen("Напиши: /find ткань — или просто слово в личку."))
        if cmd == "sync":
            return self.trigger_sync(m)
        if cmd == "cancel":
            return Result(Screen("Ок, отменил.", MENU))
        screens = {"menu": self.scr_menu, "my": self.scr_my, "next": self.scr_next, "free": self.scr_free,
                   "tasks": self.scr_stages, "plan": self.scr_plan, "milestones": self.scr_milestones,
                   "ideas": self.scr_ideas, "team": self.scr_team, "help": self.scr_help}
        fn = screens.get(cmd)
        if fn:
            return Result(fn(m))
        return Result(Screen("Не знаю такой команды. /help — список."))

    def on_text(self, who: Who, chat_id: int, private: bool, text: str) -> Optional[Result]:
        self.svc.recent = []
        if not private:
            return None
        m = self._member(who)
        if not m:
            return Result(Screen("Отправь /start, чтобы попасть в команду."))
        text = (text or "").strip()
        aw = self.st.kv_get(f"await:{m.tg_id}")
        if aw:
            return self._on_await(m, aw, text)
        if text.endswith("?") and self.ai.enabled:
            ans = self.ai.answer(text, self.st, self.today())
            if ans:
                return Result(Screen(esc(ans), MENU))
        return Result(self.scr_search(text))

    def on_callback(self, who: Who, chat_id: int, data: str) -> Result:
        self.svc.recent = []
        m = self._member(who)
        if not m:
            return Result(toast="Ты ещё не в команде — отправь /start боту в личку", alert=True)
        parts = data.split(":")
        head = parts[0]
        try:
            if head == "go":
                return self._go(m, parts[1])
            if head == "t":
                return self._task_cb(m, parts)
            if head == "s":
                return Result(self.scr_stage(m, int(parts[1]), len(parts) > 2 and parts[2] == "all"))
            if head == "ms":
                return Result(self.scr_milestone(parts[2]))
            if head == "iq":
                return Result(self.scr_idea_queue(parts[1]))
            if head == "i":
                return self._idea_cb(m, parts)
            if head == "n":
                return self._new_cb(m, parts)
            if head == "m":
                return self._member_cb(m, parts)
        except ActionError as e:
            return Result(toast=str(e), alert=True)
        except (IndexError, ValueError):
            pass
        return Result(toast="Кнопка устарела — открой заново через /menu")

    # =====================================================================
    # screens
    # =====================================================================
    def _go(self, m: Member, where: str) -> Result:
        if where == "new":
            self.st.kv_set(f"await:{m.tg_id}", {"a": "new_title"})
            return Result(Screen("Как назовём задачу? Напиши одной строкой.", [[Btn("Отмена", "n:cancel")]]))
        fn = {"today": self.scr_today, "my": self.scr_my, "next": self.scr_next, "free": self.scr_free,
              "tasks": self.scr_stages, "plan": self.scr_plan, "ms": self.scr_milestones,
              "ideas": self.scr_ideas, "team": self.scr_team, "help": self.scr_help, "menu": self.scr_menu}[where]
        return Result(fn(m))

    def scr_menu(self, m: Member) -> Screen:
        return Screen("<b>the Bear Lab Bot</b>\n\n" + "\n".join(texts.header_stats(self.st, self.today())), MENU)

    def scr_help(self, m: Member) -> Screen:
        last = self.st.kv_get("last_sync")
        tail = f"\n\n<i>Последняя синхронизация с Notion: {last[8:10]}.{last[5:7]} {last[11:16]} МСК</i>" if last else ""
        return Screen(texts.HELP + tail, MENU)

    def scr_today(self, m: Member) -> Screen:
        return Screen(texts.team_digest(self.st, self.today()),
                      [[Btn("Мои задачи", "go:my"), Btn("Что дальше", "go:next")], [Btn("Меню", "go:menu")]])

    def _task_buttons(self, tasks: list[Task]) -> list:
        today = self.today()
        return [[Btn(texts.button_label(t, today), f"t:v:{t.id}")] for t in tasks]

    def scr_my(self, m: Member) -> Screen:
        today = self.today()
        mine = [t for t in self.st.tasks() if t.assignee_tg == m.tg_id and not t.done]
        mine.sort(key=lambda t: (t.status != "В работе", t.due or date.max))
        if not mine:
            return Screen("На тебе нет открытых задач. Посмотри /free или /next.",
                          [[Btn("Свободные", "go:free"), Btn("Что дальше", "go:next")]])
        od = len(logic.overdue(mine, today))
        head = f"<b>Мои задачи ({len(mine)})</b>" + (f" · просрочено: {od}" if od else "")
        return Screen(head, self._task_buttons(mine[:40]) + [[Btn("Меню", "go:menu")]])

    def scr_next(self, m: Member) -> Screen:
        sug = logic.suggest(self.st.tasks(), self.st.milestones(), m.tg_id, self.today(), limit=3)
        if not sug:
            return Screen("Все доступные задачи разобраны или ждут других задач. Загляни в /plan.", MENU)
        lines = ["<b>Что делать дальше</b>", ""]
        kb = []
        for n, (t, _, reasons) in enumerate(sug, 1):
            lines.append(f"{n}. <b>{esc(t.title)}</b>")
            if reasons:
                lines.append(f"   <i>{esc(', '.join(reasons))}</i>")
            kb.append([Btn(f"{n}. {texts.cut(t.title, 40)}", f"t:v:{t.id}")])
        lines += ["", "Учитываю приоритет, сроки, близость вехи, сколько задач ждут эту и готовы ли зависимости."]
        return Screen("\n".join(lines), kb + [[Btn("Меню", "go:menu")]])

    def scr_free(self, m: Member) -> Screen:
        tasks = self.st.tasks()
        sug = logic.suggest(tasks, self.st.milestones(), None, self.today(), limit=15)
        blocked = [t for t in tasks if not t.done and logic.is_free(t)
                   and logic.open_deps(t, {x.id: x for x in tasks})]
        if not sug:
            return Screen("Свободных задач, готовых к старту, нет.", MENU)
        text = f"<b>Свободные задачи ({len(sug)})</b> — по важности. Открой и нажми «Взять»."
        if blocked:
            text += f"\n<i>Ещё {len(blocked)} ждут завершения других задач.</i>"
        return Screen(text, self._task_buttons([t for t, _, _ in sug]) + [[Btn("Меню", "go:menu")]])

    def scr_stages(self, m: Member) -> Screen:
        tasks = self.st.tasks()
        kb = []
        for i, s in enumerate(STAGES):
            ts = [t for t in tasks if t.stage == s]
            d, n, p = logic.progress(ts)
            kb.append([Btn(f"{s} · {d}/{n}", f"s:{i}")])
        other = [t for t in tasks if t.stage not in STAGES]
        if other:
            kb.append([Btn(f"Без этапа · {len(other)}", f"s:{len(STAGES)}")])
        return Screen("<b>Задачи по этапам</b>", kb + [[Btn("Меню", "go:menu")]])

    def scr_stage(self, m: Member, idx: int, show_all: bool = False) -> Screen:
        tasks = self.st.tasks()
        if idx < len(STAGES):
            name = STAGES[idx]
            ts = [t for t in tasks if t.stage == name]
        else:
            name = "Без этапа"
            ts = [t for t in tasks if t.stage not in STAGES]
        ts.sort(key=lambda t: (t.done, t.due or date.max, -PRIORITIES.get(t.priority, 2)))
        d, n, p = logic.progress(ts)
        shown = ts if show_all else [t for t in ts if not t.done]
        kb = self._task_buttons(shown[:50])
        if not show_all and d:
            kb.append([Btn(f"Показать выполненные ({d})", f"s:{idx}:all")])
        kb.append([Btn("← Этапы", "go:tasks"), Btn("Меню", "go:menu")])
        return Screen(f"<b>{esc(name)}</b>\n{logic.bar(p)} {d}/{n}", kb)

    def scr_plan(self, m: Member) -> Screen:
        return Screen(texts.plan(self.st, self.today()),
                      [[Btn("Вехи", "go:ms"), Btn("Этапы", "go:tasks")], [Btn("Меню", "go:menu")]])

    def scr_milestones(self, m: Member) -> Screen:
        tasks = self.st.tasks()
        ms = self.st.milestones()
        lines = ["<b>Вехи</b>", ""] + [texts.milestone_line(x, tasks, self.today()) for x in ms]
        kb = [[Btn(texts.cut(x.title, 45), f"ms:v:{x.id}")] for x in ms]
        return Screen("\n".join(lines), kb + [[Btn("Меню", "go:menu")]])

    def scr_milestone(self, mid: str) -> Screen:
        ms = {x.id: x for x in self.st.milestones()}
        x = ms.get(mid)
        if not x:
            return Screen("Веха не найдена.", MENU)
        tasks = self.st.tasks()
        linked = sorted(logic.milestone_tasks(x, tasks), key=lambda t: (t.done, t.due or date.max))
        text = texts.milestone_line(x, tasks, self.today())
        if x.criterion:
            text += f"\n\n<b>Критерий:</b> {esc(x.criterion)}"
        kb = self._task_buttons(linked[:40]) + [[Btn("Открыть в Notion", url=config.notion_url(x.id))],
                                                [Btn("← Вехи", "go:ms")]]
        return Screen(text, kb)

    def scr_search(self, query: str) -> Screen:
        hits = logic.search(query, self.st.tasks(), self.st.ideas())
        if not hits:
            return Screen(f"По запросу «{esc(query)}» ничего не нашёл.", MENU)
        kb = []
        today = self.today()
        for kind, obj in hits:
            if kind == "task":
                kb.append([Btn(texts.button_label(obj, today), f"t:v:{obj.id}")])
            else:
                kb.append([Btn(f"💡 {texts.cut(obj.title, 42)}", f"i:v:{obj.id}")])
        return Screen(f"Нашёл по запросу «{esc(query)}»:", kb + [[Btn("Меню", "go:menu")]])

    # --- task card ------------------------------------------------------
    def scr_task(self, m: Member, t: Task) -> Screen:
        evs = self.st.events(task_id=t.id)
        text = texts.task_card(t, self.st, self.today(), evs)
        kb = []
        row = []
        if not t.done:
            if t.assignee_tg == m.tg_id:
                row.append(Btn("↩️ Снять с себя", f"t:rel:{t.id}"))
            elif logic.is_free(t):
                row.append(Btn("🙋 Взять", f"t:take:{t.id}"))
            elif m.admin:
                row.append(Btn("↩️ Освободить", f"t:rel:{t.id}"))
        row.append(Btn("👥 Назначить", f"t:asg:{t.id}"))
        kb.append(row)
        kb.append([Btn(STATUS_BTN[s], f"t:st:{t.id}:{i}") for i, s in enumerate(STATUSES)
                   if s != t.status and s != "Не начато"] or [Btn("⚪ Вернуть в «Не начато»", f"t:st:{t.id}:0")])
        if not t.done:
            kb.append([Btn("+1 день", f"t:dd:{t.id}:1"), Btn("+3", f"t:dd:{t.id}:3"),
                       Btn("+7", f"t:dd:{t.id}:7"), Btn("📅 Дата", f"t:date:{t.id}")])
        kb.append([Btn("🔗 Результат", f"t:res:{t.id}"), Btn("📝 Заметка", f"t:note:{t.id}"),
                   Btn("🕘 История", f"t:log:{t.id}")])
        nav = []
        if t.notion_id:
            nav.append(Btn("Notion", url=config.notion_url(t.notion_id)))
        idx = STAGES.index(t.stage) if t.stage in STAGES else len(STAGES)
        nav.append(Btn("← Этап", f"s:{idx}"))
        nav.append(Btn("Меню", "go:menu"))
        kb.append(nav)
        return Screen(text, kb)

    def _broadcast(self, actor: Member, t: Task, kind: str, text: str, origin_chat: Optional[int] = None) -> list:
        notices = []
        group = self.st.kv_get("group_chat")
        if group and kind in BROADCAST_ICON:
            notices.append(Notice(int(group), f"{BROADCAST_ICON[kind]} <b>{esc(actor.name)}</b>: «{esc(t.title)}» — {esc(text)}",
                                  [[Btn("Открыть", f"t:v:{t.id}")]]))
        return notices

    def _dm_owner(self, actor: Member, t: Task, prev_owner: Optional[int], text: str) -> list:
        out = []
        for uid in {prev_owner, t.assignee_tg}:
            if uid and uid != actor.tg_id:
                out.append(Notice(uid, f"<b>{esc(actor.name)}</b> → «{esc(t.title)}»: {esc(text)}",
                                  [[Btn("Открыть", f"t:v:{t.id}")]]))
        return out

    def _after(self, m: Member, t: Task, prev_owner: Optional[int], toast: str) -> Result:
        evs, self.svc.recent = self.svc.recent, []
        notices = []
        for e in evs:
            if e.task_id == t.id:
                notices += self._broadcast(m, t, e.kind, e.text)
        if evs:
            notices += self._dm_owner(m, t, prev_owner, "; ".join(e.text for e in evs if e.task_id == t.id))
        return Result(self.scr_task(m, t), notices, toast)

    def _task_cb(self, m: Member, p: list[str]) -> Result:
        act, tid = p[1], p[2]
        t = self.st.task(tid)
        if not t:
            return Result(toast="Задача не найдена (возможно, удалена в Notion)", alert=True)
        prev = t.assignee_tg
        if act == "v":
            return Result(self.scr_task(m, t))
        if act == "take":
            return self._after(m, self.svc.take(t, m), prev, "Задача твоя")
        if act == "rel":
            return self._after(m, self.svc.release(t, m), prev, "Задача освобождена")
        if act == "asg":
            kb = [[Btn(("✓ " if x.tg_id == t.assignee_tg else "") + x.name, f"t:to:{t.id}:{x.tg_id}")]
                  for x in self.st.members() if x.approved]
            kb.append([Btn("Никто (освободить)", f"t:rel:{t.id}"), Btn("← Назад", f"t:v:{t.id}")])
            return Result(Screen(f"Кому назначить «{esc(t.title)}»?", kb))
        if act == "to":
            target = self.st.member(int(p[3]))
            if not target or not target.approved:
                raise ActionError("Участник не найден")
            return self._after(m, self.svc.assign(t, m, target), prev, f"Назначено: {target.name}")
        if act == "st":
            status = STATUSES[int(p[3])]
            return self._after(m, self.svc.set_status(t, m, status), prev, status)
        if act == "dd":
            return self._after(m, self.svc.postpone(t, m, int(p[3])), prev, "Срок перенесён")
        if act == "date":
            self.st.kv_set(f"await:{m.tg_id}", {"a": "due", "t": t.id})
            return Result(Screen(f"Новый срок для «{esc(t.title)}»? Например: 15.11, завтра, +5. "
                                 "Или «нет», чтобы убрать срок.", [[Btn("Отмена", f"t:v:{t.id}")]]))
        if act == "res":
            self.st.kv_set(f"await:{m.tg_id}", {"a": "result", "t": t.id})
            return Result(Screen(f"Пришли мне в личку ссылку на результат «{esc(t.title)}» "
                                 "(документ, макет, папка) или короткое описание.\n"
                                 "Задача перейдёт в «На проверке».", [[Btn("Отмена", f"t:v:{t.id}")]]))
        if act == "note":
            self.st.kv_set(f"await:{m.tg_id}", {"a": "note", "t": t.id})
            return Result(Screen(f"Напиши мне в личку заметку для журнала «{esc(t.title)}».",
                                 [[Btn("Отмена", f"t:v:{t.id}")]]))
        if act == "log":
            return Result(Screen(texts.history(t, self.st.events(task_id=t.id)), [[Btn("← Назад", f"t:v:{t.id}")]]))
        return Result(toast="Неизвестное действие")

    # --- free-text inputs -----------------------------------------------------
    def _on_await(self, m: Member, aw: dict, text: str) -> Result:
        key = f"await:{m.tg_id}"
        a = aw.get("a")
        if a == "new_title":
            if not text:
                return Result(Screen("Название пустое — напиши ещё раз."))
            self.st.kv_set(key, {"a": "new", "title": text[:200]})
            return Result(self.scr_new_stage(text))
        if a == "new_due":
            d = logic.parse_date(text, self.today())
            if not d:
                return Result(Screen("Не понял дату. Пример: 15.11, завтра, +5."))
            return self._create_from_draft(m, aw, d)
        t = self.st.task(aw.get("t", ""))
        self.st.delete("kv", key)
        if not t:
            return Result(Screen("Задача не найдена.", MENU))
        prev = t.assignee_tg
        if a == "result":
            return self._after(m, self.svc.set_result(t, m, text), prev, "")
        if a == "note":
            return Result(self.scr_task(m, self.svc.note(t, m, text)))
        if a == "due":
            if text.lower() in ("нет", "без срока", "-"):
                return self._after(m, self.svc.set_due(t, m, None), prev, "")
            d = logic.parse_date(text, self.today())
            if not d:
                self.st.kv_set(key, aw)
                return Result(Screen("Не понял дату. Пример: 15.11, завтра, +5."))
            return self._after(m, self.svc.set_due(t, m, d), prev, "")
        return Result(Screen("Ок.", MENU))

    # --- new task wizard ----------------------------------------------------
    def scr_new_stage(self, title: str) -> Screen:
        kb = [[Btn(s, f"n:st:{i}")] for i, s in enumerate(STAGES)] + [[Btn("Отмена", "n:cancel")]]
        return Screen(f"Новая задача: <b>{esc(title)}</b>\nК какому этапу?", kb)

    def _new_cb(self, m: Member, p: list[str]) -> Result:
        key = f"await:{m.tg_id}"
        draft = self.st.kv_get(key) or {}
        if p[1] == "cancel":
            self.st.delete("kv", key)
            return Result(Screen("Создание задачи отменено.", MENU))
        if draft.get("a") not in ("new", "new_due"):
            return Result(toast="Начни заново: /new", alert=True)
        if p[1] == "st":
            draft["stage"] = STAGES[int(p[2])]
            self.st.kv_set(key, draft)
            kb = [[Btn(x, f"n:pr:{x}") for x in PRIORITIES]] + [[Btn("Отмена", "n:cancel")]]
            return Result(Screen(f"<b>{esc(draft['title'])}</b>\n{esc(draft['stage'])}\nПриоритет?", kb))
        if p[1] == "pr":
            draft["priority"] = p[2] if p[2] in PRIORITIES else "Средний"
            self.st.kv_set(key, draft)
            kb = [[Btn("Без срока", "n:due:0"), Btn("+3 дня", "n:due:3"), Btn("+7", "n:due:7"), Btn("+14", "n:due:14")],
                  [Btn("📅 Своя дата", "n:due:custom")], [Btn("Отмена", "n:cancel")]]
            return Result(Screen(f"<b>{esc(draft['title'])}</b>\n{esc(draft['stage'])} · {esc(draft['priority'])}\nСрок?", kb))
        if p[1] == "due":
            if p[2] == "custom":
                draft["a"] = "new_due"
                self.st.kv_set(key, draft)
                return Result(Screen("Напиши дату: 15.11, завтра или +5.", [[Btn("Отмена", "n:cancel")]]))
            n = int(p[2])
            return self._create_from_draft(m, draft, self.today() + timedelta(days=n) if n else None)
        return Result(toast="?")

    def _create_from_draft(self, m: Member, draft: dict, due: Optional[date]) -> Result:
        self.st.delete("kv", f"await:{m.tg_id}")
        t = self.svc.create(m, draft["title"], draft.get("stage", ""), draft.get("priority", "Средний"), due)
        r = self._after(m, t, None, "Задача создана")
        r.new_message = True
        return r

    # --- ideas ---------------------------------------------------------------
    def scr_ideas(self, m: Member) -> Screen:
        ideas = self.st.ideas()
        queues = ["MVP", "v2", "Позже"]
        lines = ["<b>Бэклог идей</b>", "Открой идею и нажми «В задачи», когда команда готова её делать.", ""]
        kb = []
        for q in queues:
            new = [i for i in ideas if i.queue == q and i.status == "Новая"]
            total = [i for i in ideas if i.queue == q]
            lines.append(f"{q}: новых {len(new)} из {len(total)}")
            kb.append([Btn(f"{q} ({len(new)})", f"iq:{q}")])
        return Screen("\n".join(lines), kb + [[Btn("Меню", "go:menu")]])

    def scr_idea_queue(self, q: str) -> Screen:
        ideas = sorted([i for i in self.st.ideas() if i.queue == q], key=lambda i: (i.status != "Новая", i.group, i.title))
        icon = {"Новая": "💡", "В задачах": "➡️", "Сделано": "✅", "Отклонена": "✖️"}
        kb = [[Btn(f"{icon.get(i.status, '💡')} {texts.cut(i.title, 42)}", f"i:v:{i.id}")] for i in ideas[:50]]
        return Screen(f"<b>Идеи · {esc(q)}</b>", kb + [[Btn("← Идеи", "go:ideas")]])

    def _idea_cb(self, m: Member, p: list[str]) -> Result:
        i = self.st.idea(p[2])
        if not i:
            return Result(toast="Идея не найдена", alert=True)
        if p[1] == "v":
            kb = []
            if i.status == "Новая":
                kb.append([Btn("➕ В задачи", f"i:p:{i.id}"), Btn("✖️ Отклонить", f"i:rej:{i.id}")])
            kb.append([Btn("Notion", url=config.notion_url(i.id)), Btn("← К списку", f"iq:{i.queue}")])
            return Result(Screen(texts.idea_card(i), kb))
        if p[1] == "p":
            kb = [[Btn(s, f"i:ps:{i.id}:{n}")] for n, s in enumerate(STAGES)] + [[Btn("Отмена", f"i:v:{i.id}")]]
            return Result(Screen(f"«{esc(i.title)}» → в какой этап?", kb))
        if p[1] == "ps":
            if i.status != "Новая":
                raise ActionError("Идея уже обработана")
            t = self.svc.promote_idea(i, m, STAGES[int(p[3])])
            return self._after(m, t, None, "Идея стала задачей")
        if p[1] == "rej":
            self.svc.reject_idea(i)
            return Result(self.scr_idea_queue(i.queue), toast="Идея отклонена")
        return Result(toast="?")

    # --- team ----------------------------------------------------------------
    def scr_team(self, m: Member) -> Screen:
        tasks = self.st.tasks()
        notion = {u["id"]: u.get("name", "") for u in self.st.notion_users()}
        lines = ["<b>Команда</b>", ""]
        kb = []
        for x in self.st.members():
            if not x.approved:
                if m.admin:
                    lines.append(f"⏳ {esc(x.name)} — ждёт подтверждения")
                    kb.append([Btn(f"✅ {x.name}", f"m:ok:{x.tg_id}"), Btn("✖️", f"m:no:{x.tg_id}")])
                continue
            active = [t for t in tasks if t.assignee_tg == x.tg_id and not t.done]
            od = len(logic.overdue(active, self.today()))
            done = sum(1 for t in tasks if t.assignee_tg == x.tg_id and t.done)
            link = notion.get(x.notion_user_id or "", "") if x.notion_user_id else ""
            lines.append(f"{'⭐ ' if x.admin else ''}<b>{esc(x.name)}</b>"
                         f"{' @' + esc(x.username) if x.username else ''}\n"
                         f"    в работе {len(active)}, готово {done}" + (f", просрочено {od}" if od else "") +
                         f"\n    Notion: {esc(link) if link else 'не привязан'}")
            if m.admin or x.tg_id == m.tg_id:
                kb.append([Btn(f"🔗 Notion для {x.name}", f"m:link:{x.tg_id}")])
        group = self.st.kv_get("group_chat")
        lines += ["", "Общий чат для сводок: " + ("привязан" if group else "не привязан — /bindchat в чате")]
        return Screen("\n".join(lines), kb + [[Btn("Меню", "go:menu")]])

    def _member_cb(self, m: Member, p: list[str]) -> Result:
        act, uid = p[1], int(p[2])
        x = self.st.member(uid)
        if not x:
            return Result(toast="Участник не найден", alert=True)
        if act in ("ok", "no"):
            if not m.admin:
                raise ActionError("Только администратор")
            if act == "ok":
                x.approved = True
                self.st.save_member(x)
                return Result(self.scr_team(m), [Notice(x.tg_id, "Тебя приняли в команду TheBearLab! /help — что я умею.")],
                              f"{x.name} в команде")
            self.st.delete("member", str(uid))
            return Result(self.scr_team(m), toast="Заявка отклонена")
        if act == "link":
            if not (m.admin or uid == m.tg_id):
                raise ActionError("Можно привязать только себя")
            users = [u for u in self.st.notion_users() if u.get("type", "person") == "person"]
            if not users:
                return Result(toast="Пользователи Notion ещё не загружены — дождись синхронизации", alert=True)
            kb = [[Btn(u.get("name") or u["id"][:8], f"m:ln:{uid}:{u['id'].replace('-', '')}")] for u in users]
            kb.append([Btn("← Команда", "go:team")])
            return Result(Screen(f"Кто {esc(x.name)} в Notion?", kb))
        if act == "ln":
            if not (m.admin or uid == m.tg_id):
                raise ActionError("Можно привязать только себя")
            nid = next((u["id"] for u in self.st.notion_users() if u["id"].replace("-", "") == p[3]), None)
            if not nid:
                raise ActionError("Пользователь Notion не найден")
            x.notion_user_id = nid
            self.st.save_member(x)
            for t in self.st.tasks():
                if t.assignee_tg == uid and t.assignee_notion != nid:
                    t.assignee_notion = nid
                    t.mark("assignee_notion")
                    self.st.save_task(t)
                elif t.assignee_notion == nid and not t.assignee_tg:
                    t.assignee_tg = uid
                    self.st.save_task(t)
            if m.tg_id == uid:
                m.notion_user_id = nid
            return Result(self.scr_team(m), toast="Привязано")
        return Result(toast="?")

    # --- sync ------------------------------------------------------------------
    def trigger_sync(self, m: Member) -> Result:
        last = self.st.kv_get("last_sync")
        when = f"Последняя синхронизация: {last[8:10]}.{last[5:7]} {last[11:16]} МСК. " if last else ""
        if not config.GITHUB_TOKEN:
            return Result(Screen(when + "Синхронизация идёт автоматически каждые 15 минут."))
        stamp = self.st.kv_get("sync_requested", 0)
        if time.time() - stamp < 120:
            return Result(Screen(when + "Синхронизация уже запущена, подожди пару минут."))
        url = (f"https://api.github.com/repos/{config.GITHUB_REPO}/actions/workflows/"
               f"{config.SYNC_WORKFLOW}/dispatches")
        req = urllib.request.Request(url, data=json.dumps({"ref": "main"}).encode(), method="POST", headers={
            "Authorization": f"Bearer {config.GITHUB_TOKEN}", "Accept": "application/vnd.github+json"})
        try:
            urllib.request.urlopen(req, timeout=10)
        except Exception:
            return Result(Screen(when + "Не получилось запустить синхронизацию — она всё равно пройдёт по расписанию."))
        self.st.kv_set("sync_requested", time.time())
        return Result(Screen(when + "Запустил синхронизацию с Notion — займёт 1–2 минуты."))
