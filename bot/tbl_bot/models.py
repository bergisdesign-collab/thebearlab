"""Domain models. Plain dataclasses, serialised to JSON for storage."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, fields
from datetime import date, datetime
from typing import Any, Optional

STAGES = [
    "1. Концепция игры",
    "2. Поиск концепта",
    "3. Маркетинг",
    "4. Производство",
    "5. Логистика",
    "6. Приложение",
]
STATUSES = ["Не начато", "В работе", "На проверке", "Готово"]
DONE = "Готово"
PRIORITIES = {"Высокий": 3, "Средний": 2, "Низкий": 1}
TYPES = ["Задача", "Решение", "Риск"]

# Fields of Task that are mirrored to Notion. Bot edits mark them dirty.
PUSHABLE = (
    "title", "stage", "type", "status", "priority", "start", "due",
    "description", "result", "assignee_notion", "log", "milestones", "depends_on",
)


def _parse_date(v: Any) -> Optional[date]:
    if not v:
        return None
    if isinstance(v, date) and not isinstance(v, datetime):
        return v
    return date.fromisoformat(str(v)[:10])


class _JsonMixin:
    def to_dict(self) -> dict:
        d = asdict(self)
        for k, v in d.items():
            if isinstance(v, (date, datetime)):
                d[k] = v.isoformat()
        return d

    @classmethod
    def from_dict(cls, d: dict):
        names = {f.name for f in fields(cls)}
        kw = {k: v for k, v in d.items() if k in names}
        obj = cls(**kw)
        obj._post_load()
        return obj

    def _post_load(self):
        pass


@dataclass
class Task(_JsonMixin):
    id: str                      # Notion page id (32 hex) or "local-…" until synced
    title: str
    stage: str = ""
    type: str = "Задача"
    status: str = "Не начато"
    priority: str = "Средний"
    start: Optional[date] = None
    due: Optional[date] = None   # end of range or single date
    description: str = ""
    result: str = ""
    milestones: list = field(default_factory=list)   # milestone ids
    depends_on: list = field(default_factory=list)   # task ids
    assignee_tg: Optional[int] = None
    assignee_notion: Optional[str] = None
    log: str = ""
    notion_id: Optional[str] = None
    notion_edited: str = ""      # last_edited_time seen at last sync
    dirty: list = field(default_factory=list)        # fields to push to Notion
    rev: int = 0
    archived: bool = False

    def _post_load(self):
        self.start = _parse_date(self.start)
        self.due = _parse_date(self.due)

    @property
    def done(self) -> bool:
        return self.status == DONE

    @property
    def short(self) -> str:
        return self.id.replace("-", "")[-6:]

    def mark(self, *names: str):
        for n in names:
            if n in PUSHABLE and n not in self.dirty:
                self.dirty.append(n)
        self.rev += 1


@dataclass
class Milestone(_JsonMixin):
    id: str
    title: str
    date: Optional[date] = None
    status: str = "Впереди"
    criterion: str = ""
    dirty: list = field(default_factory=list)
    rev: int = 0

    def _post_load(self):
        self.date = _parse_date(self.date)


@dataclass
class Idea(_JsonMixin):
    id: str
    title: str
    group: str = ""
    queue: str = ""
    status: str = "Новая"
    description: str = ""
    closes: str = ""
    tasks: list = field(default_factory=list)
    dirty: list = field(default_factory=list)
    rev: int = 0


@dataclass
class Member(_JsonMixin):
    tg_id: int
    name: str
    username: str = ""
    notion_user_id: Optional[str] = None
    approved: bool = False
    admin: bool = False


@dataclass
class Event(_JsonMixin):
    id: str
    ts: str          # ISO datetime, Moscow time
    task_id: str
    actor: str       # display name
    kind: str        # take, release, assign, status, due, result, create
    text: str        # human readable
