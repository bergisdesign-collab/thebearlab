"""Message renderers (Telegram HTML)."""
from __future__ import annotations

from datetime import date, timedelta
from html import escape as esc
from typing import Iterable, Optional

from . import config, logic
from .models import STAGES, Event, Idea, Member, Milestone, Task
from .storage import Storage

STATUS_ICON = {"Не начато": "⚪", "В работе": "🔵", "На проверке": "🟡", "Готово": "✅"}
MS_ICON = {"Впереди": "◻️", "Достигнута": "✅", "Под угрозой": "⚠️", "Сорвана": "❌"}
TYPE_ICON = {"Задача": "", "Решение": "⚖️ ", "Риск": "🛡 "}
MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
          "сентября", "октября", "ноября", "декабря"]
WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]

MAX_LEN = 4000


def human_date(d: date) -> str:
    return f"{d.day} {MONTHS[d.month - 1]}"


def short_date(d: Optional[date]) -> str:
    return d.strftime("%d.%m") if d else ""


def cut(text: str, n: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def clip(text: str) -> str:
    return text if len(text) <= MAX_LEN else text[: MAX_LEN - 20].rstrip() + "\n…"


class Names:
    """Resolves assignees to display names (Telegram member first, then Notion user)."""

    def __init__(self, st: Storage):
        self.members = {m.tg_id: m for m in st.members()}
        self.notion = {u["id"]: u.get("name", "") for u in st.notion_users()}

    def of(self, t: Task) -> str:
        if t.assignee_tg and t.assignee_tg in self.members:
            return self.members[t.assignee_tg].name
        if t.assignee_notion:
            return self.notion.get(t.assignee_notion, "участник Notion")
        return ""


def due_label(t: Task, today: date) -> str:
    if not t.due:
        return ""
    d = (t.due - today).days
    if t.done:
        return short_date(t.due)
    if d < 0:
        return f"⏰ {short_date(t.due)}, просрочено {logic.days_str(-d)}"
    if d == 0:
        return "сегодня"
    if d == 1:
        return "завтра"
    return short_date(t.due)


def task_line(t: Task, names: Names, today: date, show_who: bool = True) -> str:
    parts = [f"{STATUS_ICON.get(t.status, '⚪')} {TYPE_ICON.get(t.type, '')}{esc(t.title)}"]
    dl = due_label(t, today)
    if dl:
        parts.append(dl)
    who = names.of(t)
    if show_who:
        parts.append(esc(who) if who else "свободна")
    return " · ".join(parts)


def button_label(t: Task, today: date) -> str:
    icon = STATUS_ICON.get(t.status, "⚪")
    dl = due_label(t, today).replace("⏰ ", "⏰")
    if dl.startswith("⏰"):
        dl = "⏰"
    label = f"{icon} {cut(t.title, 38)}"
    return f"{label} · {dl}" if dl else label


def task_card(t: Task, st: Storage, today: date, events: list[Event]) -> str:
    names = Names(st)
    tasks = st.tasks()
    by_id = {x.id: x for x in tasks}
    ms = {m.id: m for m in st.milestones()}
    lines = [f"<b>{TYPE_ICON.get(t.type, '')}{esc(t.title)}</b>",
             f"<i>{esc(t.stage or 'Без этапа')} · {esc(t.type)} · приоритет: {esc(t.priority.lower())}</i>",
             "",
             f"Статус: {STATUS_ICON.get(t.status, '')} {esc(t.status)}"]
    if t.due:
        d = (t.due - today).days
        rel = ("" if t.done else f" — просрочено на {logic.days_str(-d)}" if d < 0
               else " — сегодня" if d == 0 else f" — через {logic.days_str(d)}")
        span = f"{short_date(t.start)}–" if t.start else ""
        lines.append(f"Срок: {span}{short_date(t.due)}{rel}")
    who = names.of(t)
    lines.append(f"Исполнитель: {esc(who) if who else 'свободна — можно взять'}")
    if t.milestones:
        ml = [f"«{esc(ms[i].title)}» {short_date(ms[i].date)}" for i in t.milestones if i in ms]
        if ml:
            lines.append("Веха: " + ", ".join(ml))
    deps = [by_id[d] for d in t.depends_on if d in by_id]
    if deps:
        lines.append("Зависит от: " + "; ".join(
            f"{'✅' if x.done else '⏳'} {esc(cut(x.title, 40))}" for x in deps))
    blocks = logic.blocked_tasks(t, tasks)
    if blocks:
        lines.append(f"Блокирует: {len(blocks)} {logic.plural(len(blocks), logic.TASKS)}")
    if t.result:
        r = esc(t.result)
        lines.append(f"Результат: <a href=\"{r}\">{esc(cut(t.result, 60))}</a>"
                     if t.result.startswith("http") else f"Результат: {r}")
    if t.description:
        lines += ["", esc(cut(t.description, 700))]
    if events:
        lines += ["", "<b>История</b>"]
        for e in events[-5:]:
            lines.append(f"<code>{e.ts[8:10]}.{e.ts[5:7]} {e.ts[11:16]}</code> {esc(e.actor)}: {esc(cut(e.text, 120))}")
    if t.dirty and t.id.startswith("local-"):
        lines += ["", "<i>Появится в Notion после ближайшей синхронизации.</i>"]
    return clip("\n".join(lines))


def history(t: Task, events: list[Event]) -> str:
    lines = [f"<b>История: {esc(t.title)}</b>", ""]
    if not events:
        lines.append("Пока пусто.")
    for e in events[-40:]:
        lines.append(f"<code>{e.ts[8:10]}.{e.ts[5:7]} {e.ts[11:16]}</code> {esc(e.actor)}: {esc(e.text)}")
    if t.log and not events:
        lines += ["", "<b>Журнал из Notion</b>", esc(cut(t.log, 2500))]
    return clip("\n".join(lines))


def milestone_line(m: Milestone, tasks: list[Task], today: date) -> str:
    linked = logic.milestone_tasks(m, tasks)
    done = sum(1 for t in linked if t.done)
    pct = round(100 * done / len(linked)) if linked else 0
    when = ""
    if m.date:
        d = (m.date - today).days
        when = f"{short_date(m.date)}" + (f", через {logic.days_str(d)}" if d > 0 else ", сегодня" if d == 0 else "")
    return (f"{MS_ICON.get(m.status, '◻️')} <b>{esc(m.title)}</b> — {when}\n"
            f"    {logic.bar(pct, 10)} {done}/{len(linked)}")


def header_stats(st: Storage, today: date) -> list[str]:
    tasks = st.tasks()
    done, total, pct = logic.progress(tasks)
    days = logic.days_to_launch(st.milestones(), today)
    streak = logic.streak(st.days(), today)
    lines = []
    if days > 0:
        lines.append(f"🚀 До запуска продаж: <b>{logic.days_str(days)}</b>")
    lines.append(f"Прогресс: {logic.bar(pct)} <b>{pct}%</b> ({done}/{total})")
    lines.append(f"Серия без просрочек: <b>{logic.days_str(streak)}</b>")
    return lines


def team_digest(st: Storage, today: date, title: str = "Сводка") -> str:
    tasks = st.tasks()
    names = Names(st)
    lines = [f"<b>TheBearLab · {title} на {human_date(today)}, {WEEKDAYS[today.weekday()]}</b>", ""]
    lines += header_stats(st, today)

    od = logic.overdue(tasks, today)
    if od:
        lines += ["", f"<b>⏰ Просрочено ({len(od)})</b>"]
        lines += [task_line(t, names, today) for t in od[:8]]
        if len(od) > 8:
            lines.append(f"…и ещё {len(od) - 8}")
    td = logic.due_on(tasks, today)
    if td:
        lines += ["", f"<b>📅 Срок сегодня ({len(td)})</b>"]
        lines += [task_line(t, names, today) for t in td[:8]]
    soon = [t for t in logic.due_within(tasks, today + timedelta(days=1), 2)]
    if soon:
        lines += ["", "<b>Ближайшие 3 дня</b>"]
        lines += [task_line(t, names, today) for t in soon[:6]]

    nm = logic.next_milestone(st.milestones(), today)
    if nm:
        lines += ["", "<b>🎯 Ближайшая веха</b>", milestone_line(nm, tasks, today)]

    free = logic.suggest(tasks, st.milestones(), None, today, limit=4)
    if free:
        lines += ["", "<b>🙋 Можно взять</b>"]
        for t, _, reasons in free:
            why = f" — {esc(', '.join(reasons[:2]))}" if reasons else ""
            lines.append(f"• {esc(t.title)}{why}")
    return clip("\n".join(lines))


def personal(st: Storage, m: Member, today: date, evening: bool = False) -> Optional[str]:
    tasks = st.tasks()
    names = Names(st)
    mine = [t for t in tasks if t.assignee_tg == m.tg_id and not t.done]
    od = [t for t in logic.overdue(mine, today)]
    td = logic.due_on(mine, today)
    work = [t for t in mine if t.status == "В работе" and t not in od and t not in td]
    lines = []
    if evening:
        if not (od or td):
            return None
        lines.append(f"<b>{esc(m.name)}, вечерняя сверка</b>")
        if td:
            lines += ["", "Срок сегодня — отметь результат или перенеси:"]
            lines += [task_line(t, names, today, show_who=False) for t in td]
        if od:
            lines += ["", "Просрочено:"]
            lines += [task_line(t, names, today, show_who=False) for t in od]
        return "\n".join(lines)

    lines.append(f"<b>Доброе утро, {esc(m.name)}!</b>")
    s = logic.streak(st.days(), today, str(m.tg_id))
    if s:
        lines.append(f"Твоя серия без просрочек: {logic.days_str(s)}")
    if od:
        lines += ["", "<b>⏰ Просрочено</b>"] + [task_line(t, names, today, False) for t in od]
    if td:
        lines += ["", "<b>📅 Сегодня</b>"] + [task_line(t, names, today, False) for t in td]
    if work:
        lines += ["", "<b>🔵 В работе</b>"] + [task_line(t, names, today, False) for t in work[:6]]
    sug = logic.suggest(tasks, st.milestones(), m.tg_id, today, limit=1)
    if sug:
        t, _, reasons = sug[0]
        lines += ["", f"<b>Совет дня:</b> {esc(t.title)}"]
        if reasons:
            lines.append(f"<i>{esc(', '.join(reasons))}</i>")
    if len(lines) == 1:
        lines.append("Задач на тебе нет — загляни в /free.")
    return "\n".join(lines)


def weekly(st: Storage, today: date) -> str:
    tasks = st.tasks()
    by_id = {t.id: t for t in st.tasks(include_archived=True)}
    names = Names(st)
    since = (today - timedelta(days=6)).isoformat()
    evs = st.events(since)
    done_ids = []
    per_actor: dict[str, int] = {}
    for e in evs:
        if e.kind == "done" and e.task_id not in done_ids:
            done_ids.append(e.task_id)
            per_actor[e.actor] = per_actor.get(e.actor, 0) + 1
    lines = [f"<b>TheBearLab · итоги недели ({short_date(today - timedelta(days=6))}–{short_date(today)})</b>", ""]
    lines += header_stats(st, today)
    lines += ["", f"<b>✅ Закрыто за неделю: {len(done_ids)}</b>"]
    for i in done_ids[:12]:
        if i in by_id:
            lines.append(f"• {esc(by_id[i].title)}")
    if per_actor:
        lines.append("Кто закрывал: " + ", ".join(f"{esc(a)} — {n}" for a, n in sorted(per_actor.items(), key=lambda x: -x[1])))
    od = logic.overdue(tasks, today)
    if od:
        lines += ["", f"<b>⏰ Просрочено ({len(od)})</b>"] + [task_line(t, names, today) for t in od[:8]]
    nxt = logic.due_within(tasks, today + timedelta(days=1), 7)
    if nxt:
        lines += ["", "<b>📅 Сроки на следующей неделе</b>"] + [task_line(t, names, today) for t in nxt[:10]]
    lines += ["", "<b>Вехи</b>"]
    for m in st.milestones():
        if m.status != "Достигнута" or (m.date and m.date >= today - timedelta(days=7)):
            lines.append(milestone_line(m, tasks, today))
    return clip("\n".join(lines))


def plan(st: Storage, today: date) -> str:
    tasks = st.tasks()
    lines = ["<b>Роадмап TheBearLab</b>", ""] + header_stats(st, today) + ["", "<b>Вехи</b>"]
    for m in st.milestones():
        lines.append(milestone_line(m, tasks, today))
    lines += ["", "<b>Этапы</b>"]
    for s in STAGES:
        ts = [t for t in tasks if t.stage == s]
        if not ts:
            continue
        d, n, p = logic.progress(ts)
        lines.append(f"{esc(s)}\n    {logic.bar(p, 10)} {d}/{n}")
    return clip("\n".join(lines))


def idea_card(i: Idea) -> str:
    lines = [f"<b>💡 {esc(i.title)}</b>",
             f"<i>{esc(i.group)} · очередь: {esc(i.queue or '—')} · {esc(i.status)}</i>"]
    if i.description:
        lines += ["", esc(cut(i.description, 1200))]
    if i.closes:
        lines += ["", f"<b>Что закрывает:</b> {esc(cut(i.closes, 500))}"]
    return clip("\n".join(lines))


HELP = """<b>the Bear Lab Bot</b> — штурман по роадмапу запуска TheBearLab.

/today — сводка: прогресс, просрочки, сроки, ближайшая веха
/my — мои задачи
/next — что делать дальше (с объяснением почему)
/free — свободные задачи, которые можно взять
/tasks — задачи по этапам
/plan — роадмап: вехи и этапы
/milestones — вехи
/ideas — бэклог идей → превращаются в задачи
/new — новая задача
/find текст — поиск (или просто напиши слово в личку)
/team — команда и привязка к Notion
/sync — синхронизировать с Notion сейчас

В карточке задачи: взять / снять с себя / назначить, статус, перенос срока, результат (ссылка), заметка в журнал, история.
Все изменения видны команде и попадают в Notion (поле «Журнал»). В общем чате: /bindchat — сделать его чатом для утренних сводок."""
