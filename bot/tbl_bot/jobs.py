"""Scheduled jobs. Each returns a list of Notices; the caller sends them.

Schedule (Moscow time), set as Yandex Cloud timer triggers — see deploy/README.md:
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
