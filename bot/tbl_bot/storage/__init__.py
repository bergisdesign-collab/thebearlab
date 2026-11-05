"""Key-value document storage with two backends: SQLite (local/tests) and Firestore (Google Cloud).

Everything is stored as JSON documents addressed by (kind, id):
  task, milestone, idea, member, notion_user, kv, day, fsm
Events (task history) live in a separate append-only collection.
"""
from __future__ import annotations

import json
import os
from typing import Iterable, Optional

from ..models import Event, Idea, Member, Milestone, Task


class Storage:
    """Backend-independent API. Subclasses implement the five primitives."""

    # --- primitives -------------------------------------------------------
    def get(self, kind: str, id: str) -> Optional[dict]:
        raise NotImplementedError

    def all(self, kind: str) -> list[dict]:
        raise NotImplementedError

    def put(self, kind: str, id: str, data: dict) -> None:
        raise NotImplementedError

    def delete(self, kind: str, id: str) -> None:
        raise NotImplementedError

    def add_event(self, ev: Event) -> None:
        raise NotImplementedError

    def events(self, since_iso: str = "", task_id: str = "") -> list[Event]:
        raise NotImplementedError

    # --- request scoping (backends with a read cache override these) ---------
    def begin(self) -> None:
        """Start of a request: forget cached reads."""

    def refresh(self, kind: str) -> None:
        """Drop the cached copy of one kind so the next read sees other writers."""

    # --- typed helpers ----------------------------------------------------
    def tasks(self, include_archived: bool = False) -> list[Task]:
        out = [Task.from_dict(d) for d in self.all("task")]
        return [t for t in out if include_archived or not t.archived]

    def task(self, id: str) -> Optional[Task]:
        d = self.get("task", id)
        return Task.from_dict(d) if d else None

    def find_task(self, ref: str) -> Optional[Task]:
        """Find by full id or by the 6-char short code shown in the bot."""
        t = self.task(ref)
        if t:
            return t
        ref = ref.lower()
        for t in self.tasks():
            if t.id.replace("-", "").lower().endswith(ref):
                return t
        return None

    def save_task(self, t: Task) -> None:
        self.put("task", t.id, t.to_dict())

    def milestones(self) -> list[Milestone]:
        ms = [Milestone.from_dict(d) for d in self.all("milestone")]
        return sorted(ms, key=lambda m: (m.date is None, m.date))

    def save_milestone(self, m: Milestone) -> None:
        self.put("milestone", m.id, m.to_dict())

    def ideas(self) -> list[Idea]:
        return [Idea.from_dict(d) for d in self.all("idea")]

    def idea(self, id: str) -> Optional[Idea]:
        d = self.get("idea", id)
        return Idea.from_dict(d) if d else None

    def save_idea(self, i: Idea) -> None:
        self.put("idea", i.id, i.to_dict())

    def members(self) -> list[Member]:
        return [Member.from_dict(d) for d in self.all("member")]

    def member(self, tg_id: int) -> Optional[Member]:
        d = self.get("member", str(tg_id))
        return Member.from_dict(d) if d else None

    def save_member(self, m: Member) -> None:
        self.put("member", str(m.tg_id), m.to_dict())

    def notion_users(self) -> list[dict]:
        return self.all("notion_user")

    def kv_get(self, key: str, default=None):
        d = self.get("kv", key)
        return d["v"] if d else default

    def kv_set(self, key: str, value) -> None:
        self.put("kv", key, {"v": value})

    def record_day(self, day_iso: str, overdue: int, done: int, overdue_by_member: dict) -> None:
        self.put("day", day_iso, {"overdue": overdue, "done": done, "by_member": overdue_by_member})

    def days(self) -> dict[str, dict]:
        out = {}
        for kind_id, d in self._all_with_ids("day"):
            out[kind_id] = d
        return out

    def _all_with_ids(self, kind: str) -> Iterable[tuple[str, dict]]:
        raise NotImplementedError


def open_storage() -> Storage:
    """Firestore on Google Cloud (STORAGE=firestore, set by the deploy), otherwise a SQLite file."""
    if os.environ.get("STORAGE", "").lower() == "firestore":
        from .firestore_store import FirestoreStorage
        return FirestoreStorage(prefix=os.environ.get("FIRESTORE_PREFIX", "tbl"))
    from .sqlite import SqliteStorage
    return SqliteStorage(os.environ.get("TBL_SQLITE", "tbl_bot.sqlite3"))


def dumps(d: dict) -> str:
    return json.dumps(d, ensure_ascii=False, separators=(",", ":"))
