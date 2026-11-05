"""Pure roadmap logic: progress, streaks, mentor scoring, milestone risk, search.

No I/O here, so everything is unit-tested directly.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Iterable, Optional

from . import config
from .models import DONE, PRIORITIES, Idea, Milestone, Task


def is_holiday(d: date) -> bool:
    return config.HOLIDAY_START <= d <= config.HOLIDAY_END


def skip_holidays(d: date) -> date:
    """Deadlines never land on the New-year break: move them to the first working day after."""
    return config.HOLIDAY_END + timedelta(days=1) if is_holiday(d) else d


def plural(n: int, forms: tuple[str, str, str]) -> str:
    n = abs(n)
    if n % 10 == 1 and n % 100 != 11:
        return forms[0]
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return forms[1]
    return forms[2]


DAYS = ("день", "дня", "дней")
TASKS = ("задача", "задачи", "задач")


def days_str(n: int) -> str:
    return f"{n} {plural(n, DAYS)}"


# --- progress ---------------------------------------------------------------

def progress(tasks: Iterable[Task]) -> tuple[int, int, int]:
    ts = list(tasks)
    done = sum(1 for t in ts if t.done)
    total = len(ts)
    pct = round(100 * done / total) if total else 0
    return done, total, pct


def bar(pct: int, width: int = 12) -> str:
    filled = max(0, min(width, round(pct * width / 100)))
    return "▰" * filled + "▱" * (width - filled)


def overdue(tasks: Iterable[Task], today: date) -> list[Task]:
    out = [t for t in tasks if not t.done and t.due and t.due < today]
    return sorted(out, key=lambda t: t.due)


def due_on(tasks: Iterable[Task], day: date) -> list[Task]:
    return [t for t in tasks if not t.done and t.due == day]


def due_within(tasks: Iterable[Task], today: date, days: int) -> list[Task]:
    end = today + timedelta(days=days)
    out = [t for t in tasks if not t.done and t.due and today <= t.due <= end]
    return sorted(out, key=lambda t: t.due)


def open_deps(t: Task, by_id: dict[str, Task]) -> list[Task]:
    return [by_id[d] for d in t.depends_on if d in by_id and not by_id[d].done]


def blocked_tasks(t: Task, tasks: Iterable[Task]) -> list[Task]:
    return [x for x in tasks if t.id in x.depends_on and not x.done]


def is_free(t: Task) -> bool:
    return not t.assignee_tg and not t.assignee_notion


def days_to_launch(milestones: Iterable[Milestone], today: date) -> int:
    d = config.LAUNCH_DATE
    for m in milestones:
        if m.title.strip().lower() == config.LAUNCH_MILESTONE.lower() and m.date:
            d = m.date
    return (d - today).days


# --- streak -----------------------------------------------------------------

def streak(days: dict[str, dict], today: date, member_key: Optional[str] = None) -> int:
    """Consecutive recorded days without overdue tasks, ending today (or yesterday if today
    is not recorded yet). Holidays are transparent: they neither count nor break the streak."""
    if not days:
        return 0
    earliest = min(date.fromisoformat(k) for k in days)
    d = today if today.isoformat() in days else today - timedelta(days=1)
    n = 0
    while d >= earliest:
        rec = days.get(d.isoformat())
        if rec is None:
            if is_holiday(d):
                d -= timedelta(days=1)
                continue
            break
        ov = rec.get("overdue", 0) if member_key is None else rec.get("by_member", {}).get(member_key, 0)
        if ov:
            break
        if not is_holiday(d):
            n += 1
        d -= timedelta(days=1)
    return n


def overdue_by_member(tasks: Iterable[Task], today: date) -> dict[str, int]:
    out: dict[str, int] = {}
    for t in overdue(tasks, today):
        if t.assignee_tg:
            out[str(t.assignee_tg)] = out.get(str(t.assignee_tg), 0) + 1
    return out


# --- milestones -------------------------------------------------------------

def milestone_tasks(m: Milestone, tasks: Iterable[Task]) -> list[Task]:
    return [t for t in tasks if m.id in t.milestones]


def milestone_status(m: Milestone, tasks: Iterable[Task], today: date) -> str:
    linked = milestone_tasks(m, tasks)
    if not linked:
        return m.status
    done = sum(1 for t in linked if t.done)
    if done == len(linked):
        return "Достигнута"
    if m.date and m.date < today:
        return "Сорвана"
    if overdue(linked, today):
        return "Под угрозой"
    if m.date and (m.date - today).days <= 7 and done / len(linked) < 0.7:
        return "Под угрозой"
    return "Впереди"


def next_milestone(milestones: Iterable[Milestone], today: date) -> Optional[Milestone]:
    upcoming = [m for m in milestones if m.date and m.date >= today and m.status != "Достигнута"]
    return min(upcoming, key=lambda m: m.date) if upcoming else None


# --- mentor -----------------------------------------------------------------

def score_task(t: Task, tasks: list[Task], ms_by_id: dict[str, Milestone],
               tg_id: Optional[int], today: date) -> tuple[int, list[str]]:
    reasons: list[str] = []
    score = PRIORITIES.get(t.priority, 2) * 10
    mine = tg_id is not None and t.assignee_tg == tg_id
    if mine and t.status == "В работе":
        score += 100
        reasons.append("ты уже ведёшь её")
    elif mine:
        score += 20
        reasons.append("назначена на тебя")
    if t.priority == "Высокий":
        reasons.append("высокий приоритет")
    if t.due:
        d = (t.due - today).days
        if d < 0:
            score += 50
            reasons.append(f"просрочена на {days_str(-d)}")
        elif d == 0:
            score += 30
            reasons.append("срок сегодня")
        elif d <= 2:
            score += 30
            reasons.append(f"срок через {days_str(d)}")
        elif d <= 7:
            score += 15
            reasons.append(f"срок через {days_str(d)}")
    for mid in t.milestones:
        m = ms_by_id.get(mid)
        if m and m.date and 0 <= (m.date - today).days <= 14:
            score += 10
            reasons.append(f"веха «{m.title}» через {days_str((m.date - today).days)}")
            break
    b = len(blocked_tasks(t, tasks))
    if b:
        score += 5 * b
        reasons.append(f"разблокирует {b} {plural(b, TASKS)}")
    if t.type == "Решение":
        score += 5
        reasons.append("нужно принять решение")
    return score, reasons


def suggest(tasks: list[Task], milestones: list[Milestone], tg_id: Optional[int],
            today: date, limit: int = 3) -> list[tuple[Task, int, list[str]]]:
    """What to do next. Only tasks whose dependencies are done and that are free or mine."""
    by_id = {t.id: t for t in tasks}
    ms_by_id = {m.id: m for m in milestones}
    out = []
    for t in tasks:
        if t.done or t.status == "На проверке":
            continue
        mine = tg_id is not None and t.assignee_tg == tg_id
        if not mine and not is_free(t):
            continue
        if open_deps(t, by_id):
            continue
        s, r = score_task(t, tasks, ms_by_id, tg_id, today)
        out.append((t, s, r))
    out.sort(key=lambda x: (-x[1], x[0].due or date.max, x[0].title))
    return out[:limit]


# --- search -----------------------------------------------------------------

_word = re.compile(r"[\wё]+", re.I)


def _tokens(s: str) -> list[str]:
    return [w.lower().replace("ё", "е") for w in _word.findall(s or "") if len(w) > 1]


def _match(tokens: list[str], text: str) -> int:
    words = _tokens(text)
    score = 0
    for q in tokens:
        stem = q[:max(4, len(q) - 2)]   # crude Russian stemming: «ткани» ~ «ткань»
        if any(w.startswith(stem) for w in words):
            score += 1
    return score


def search(query: str, tasks: list[Task], ideas: list[Idea], limit: int = 10):
    q = _tokens(query)
    if not q:
        return []
    hits = []
    for t in tasks:
        s = _match(q, t.title) * 3 + _match(q, t.description) + _match(q, t.stage)
        if s:
            hits.append((s + (0 if t.done else 1), "task", t))
    for i in ideas:
        s = _match(q, i.title) * 3 + _match(q, i.description) + _match(q, i.closes)
        if s:
            hits.append((s, "idea", i))
    hits.sort(key=lambda h: -h[0])
    return [(kind, obj) for _, kind, obj in hits[:limit]]


def parse_date(text: str, today: date) -> Optional[date]:
    """Accepts 15.11, 15.11.2026, 2026-11-15, «завтра», «+3»."""
    s = text.strip().lower()
    if s in ("сегодня",):
        return today
    if s in ("завтра",):
        return today + timedelta(days=1)
    m = re.fullmatch(r"\+(\d{1,3})", s)
    if m:
        return today + timedelta(days=int(m.group(1)))
    m = re.fullmatch(r"(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?", s)
    try:
        if m:
            d, mo, y = int(m.group(1)), int(m.group(2)), m.group(3)
            if y:
                year = int(y) + (2000 if len(y) == 2 else 0)
                return date(year, mo, d)
            cand = date(today.year, mo, d)
            return cand if cand >= today - timedelta(days=30) else date(today.year + 1, mo, d)
        return date.fromisoformat(s)
    except ValueError:
        return None
