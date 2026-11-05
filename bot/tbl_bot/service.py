"""Task actions. Every change: updates the task, writes an Event (history), appends a line
to the task's «Журнал» and marks changed fields dirty so the sync pushes them to Notion."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from typing import Callable, Optional

from . import config, logic
from .models import DONE, STATUSES, Event, Idea, Member, Task
from .storage import Storage

LOG_LIMIT = 1900


class ActionError(Exception):
    """Shown to the user as a toast."""


def _fmt(d: Optional[date]) -> str:
    return d.strftime("%d.%m") if d else "—"


class Service:
    def __init__(self, st: Storage, now_fn: Callable[[], datetime] = config.now):
        self.st = st
        self.now = now_fn
        self.recent: list[Event] = []   # events produced since the caller last cleared it

    def today(self) -> date:
        return self.now().date()

    # --- history ------------------------------------------------------------
    def _log(self, t: Task, actor: Member, kind: str, text: str) -> Event:
        ts = self.now()
        ev = Event(id=uuid.uuid4().hex, ts=ts.isoformat(timespec="seconds"), task_id=t.id,
                   actor=actor.name, kind=kind, text=text)
        self.st.add_event(ev)
        self.recent.append(ev)
        line = f"{ts:%d.%m %H:%M} {actor.name}: {text}"
        log = (t.log + "\n" + line).strip() if t.log else line
        if len(log) > LOG_LIMIT:
            log = log[-LOG_LIMIT:]
            log = log[log.find("\n") + 1:] if "\n" in log else log
        t.log = log
        t.mark("log")
        return ev

    def _save(self, t: Task) -> Task:
        self.st.save_task(t)
        return t

    # --- assignment ---------------------------------------------------------
    def take(self, t: Task, m: Member) -> Task:
        if t.done:
            raise ActionError("Задача уже выполнена")
        if t.assignee_tg == m.tg_id:
            raise ActionError("Задача уже у тебя")
        if t.assignee_tg and t.assignee_tg != m.tg_id:
            owner = self.st.member(t.assignee_tg)
            raise ActionError(f"Задачу ведёт {owner.name if owner else 'другой участник'}")
        t.assignee_tg, t.assignee_notion = m.tg_id, m.notion_user_id
        t.mark("assignee_notion")
        if t.status == "Не начато":
            t.status = "В работе"
            t.mark("status")
        self._log(t, m, "take", "взята в работу")
        return self._save(t)

    def release(self, t: Task, m: Member) -> Task:
        if t.assignee_tg != m.tg_id and not m.admin:
            raise ActionError("Снять с себя можно только свою задачу")
        prev = self.st.member(t.assignee_tg) if t.assignee_tg else None
        t.assignee_tg, t.assignee_notion = None, None
        t.mark("assignee_notion")
        if t.status == "В работе":
            t.status = "Не начато"
            t.mark("status")
        who = "" if (prev and prev.tg_id == m.tg_id) or not prev else f" (была у {prev.name})"
        self._log(t, m, "release", "задача освобождена" + who)
        return self._save(t)

    def assign(self, t: Task, actor: Member, target: Member) -> Task:
        if t.assignee_tg == target.tg_id:
            raise ActionError(f"Уже назначена на {target.name}")
        t.assignee_tg, t.assignee_notion = target.tg_id, target.notion_user_id
        t.mark("assignee_notion")
        self._log(t, actor, "assign", f"назначена на {target.name}")
        return self._save(t)

    # --- status / dates / results -------------------------------------------
    def set_status(self, t: Task, actor: Member, status: str) -> Task:
        if status not in STATUSES:
            raise ActionError("Неизвестный статус")
        if status == t.status:
            raise ActionError(f"Статус уже «{status}»")
        old, t.status = t.status, status
        t.mark("status")
        if status == "В работе" and not t.assignee_tg:
            t.assignee_tg, t.assignee_notion = actor.tg_id, actor.notion_user_id
            t.mark("assignee_notion")
        self._log(t, actor, "done" if status == DONE else "status", f"статус: {old} → {status}")
        return self._save(t)

    def set_due(self, t: Task, actor: Member, new: Optional[date]) -> Task:
        if new:
            new = logic.skip_holidays(new)
        old, t.due = t.due, new
        if t.start and new and t.start > new:
            t.start = None
            t.mark("start")
        t.mark("due")
        self._log(t, actor, "due", f"срок: {_fmt(old)} → {_fmt(new)}")
        return self._save(t)

    def postpone(self, t: Task, actor: Member, days: int) -> Task:
        base = max(t.due or self.today(), self.today()) if days > 0 else (t.due or self.today())
        return self.set_due(t, actor, base + timedelta(days=days))

    def set_result(self, t: Task, actor: Member, result: str) -> Task:
        result = result.strip()
        t.result = result
        t.mark("result")
        self._log(t, actor, "result", f"результат: {result}")
        if t.status in ("Не начато", "В работе"):
            old, t.status = t.status, "На проверке"
            t.mark("status")
            self._log(t, actor, "status", f"статус: {old} → На проверке")
        return self._save(t)

    def note(self, t: Task, actor: Member, text: str) -> Task:
        self._log(t, actor, "note", text.strip()[:500])
        return self._save(t)

    # --- creation -----------------------------------------------------------
    def create(self, actor: Member, title: str, stage: str, priority: str = "Средний",
               due: Optional[date] = None, ttype: str = "Задача", description: str = "") -> Task:
        t = Task(id="local-" + uuid.uuid4().hex[:12], title=title.strip()[:200], stage=stage,
                 type=ttype, priority=priority, due=logic.skip_holidays(due) if due else None,
                 description=description)
        t.mark("title", "stage", "type", "status", "priority", "due", "description")
        self._log(t, actor, "create", "задача создана в боте")
        return self._save(t)

    def promote_idea(self, idea: Idea, actor: Member, stage: str) -> Task:
        desc = idea.description
        if idea.closes:
            desc = (desc + "\n\nЧто закрывает: " + idea.closes).strip()
        t = self.create(actor, idea.title, stage, priority="Средний", description=desc)
        idea.status = "В задачах"
        idea.tasks.append(t.id)
        for f in ("status", "tasks"):
            if f not in idea.dirty:
                idea.dirty.append(f)
        idea.rev += 1
        self.st.save_idea(idea)
        return t

    def reject_idea(self, idea: Idea) -> Idea:
        idea.status = "Отклонена"
        if "status" not in idea.dirty:
            idea.dirty.append("status")
        idea.rev += 1
        self.st.save_idea(idea)
        return idea

    # --- milestones ---------------------------------------------------------
    def refresh_milestones(self) -> list[tuple[str, str, str]]:
        """Recalculate milestone statuses from linked tasks. Returns changes (title, old, new)."""
        tasks = self.st.tasks()
        changes = []
        for m in self.st.milestones():
            new = logic.milestone_status(m, tasks, self.today())
            if new != m.status:
                changes.append((m.title, m.status, new))
                m.status = new
                if "status" not in m.dirty:
                    m.dirty.append("status")
                m.rev += 1
                self.st.save_milestone(m)
        return changes

    def record_today(self) -> None:
        tasks = self.st.tasks()
        today = self.today()
        self.st.record_day(today.isoformat(), len(logic.overdue(tasks, today)),
                           sum(1 for t in tasks if t.done), logic.overdue_by_member(tasks, today))
