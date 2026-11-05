"""Scheduled jobs. Each returns a list of Notices; the caller sends them.

Schedule (Moscow time, config.JOBS). One Cloud Scheduler job pings /cron/tick every 10 minutes;
`due()` decides which jobs to run so each fires once a day, on the first tick after its time:
  morning  09:00 daily   — team digest to the group + personal plan to each member
  evening  18:00 daily   — personal reminders about today's / overdue deadlines
  weekly   18:00 Friday  — week results to the group
No quiet hours by request; New-year holidays (config.HOLIDAY_*) are skipped.
"""
from __future__ import annotations

from datetime import datetime
from typing import Callable

from . import config, logic, texts
from .app import Btn, Notice
from .service import Service
from .storage import Storage

MORNING_KB = [[Btn("Мои задачи", "go:my"), Btn("Что дальше", "go:next")]]


def due(st: Storage, now: datetime) -> list[str]:
    """Jobs whose time has come today and that have not run yet (window: 2 hours)."""
    out = []
    minutes = now.hour * 60 + now.minute
    for name, j in config.JOBS.items():
        if j["weekday"] is not None and now.weekday() != j["weekday"]:
            continue
        start = j["hour"] * 60 + j["minute"]
        if start <= minutes < start + 120 and not st.kv_get(f"ran:{name}:{now.date().isoformat()}"):
            out.append(name)
    return out


def mark_done(st: Storage, job: str, now: datetime) -> None:
    st.kv_set(f"ran:{job}:{now.date().isoformat()}", now.isoformat(timespec="seconds"))


def run(job: str, st: Storage, now_fn: Callable[[], datetime] = config.now) -> list[Notice]:
    svc = Service(st, now_fn)
    today = now_fn().date()
    if logic.is_holiday(today):
        return []
    changes = svc.refresh_milestones()
    svc.record_today()
    group = st.kv_get("group_chat")
    members = [m for m in st.members() if m.approved]
    out: list[Notice] = []

    if job == "morning":
        if group:
            text = texts.team_digest(st, today)
            if changes:
                text += "\n\n<b>Изменились статусы вех:</b>\n" + "\n".join(
                    f"• {texts.esc(t)}: {o} → {n}" for t, o, n in changes)
            out.append(Notice(int(group), text, [[Btn("Свободные задачи", "go:free")]]))
        for m in members:
            msg = texts.personal(st, m, today)
            if msg:
                out.append(Notice(m.tg_id, msg, MORNING_KB))
    elif job == "evening":
        for m in members:
            msg = texts.personal(st, m, today, evening=True)
            if msg:
                out.append(Notice(m.tg_id, msg, [[Btn("Мои задачи", "go:my")]]))
        if group:
            od = logic.overdue(st.tasks(), today)
            streak = logic.streak(st.days(), today)
            if od:
                out.append(Notice(int(group), f"Вечерняя сверка: просрочено {len(od)}. "
                                              f"Закройте или перенесите, чтобы не потерять серию."))
            elif streak:
                out.append(Notice(int(group), f"День без просрочек ✅ Серия: {logic.days_str(streak)}."))
    elif job == "weekly":
        if group:
            out.append(Notice(int(group), texts.weekly(st, today), [[Btn("Роадмап", "go:plan")]]))
    return out
