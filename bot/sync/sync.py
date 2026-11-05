"""Two-way Notion ↔ bot storage sync. Runs in GitHub Actions every 15 minutes.

Rules
  * Pull: every Notion field overwrites the bot copy, EXCEPT fields the bot changed and has not
    pushed yet (Task.dirty) — those win and are pushed right after.
  * Push: only dirty fields are sent; a field leaves `dirty` only if it still has the pushed value
    (so a change made in the bot during the sync is not lost).
  * Tasks created in the bot ("local-…") become Notion pages; their id in the bot stays the same,
    the Notion page id is kept in Task.notion_id.
  * Pages deleted/archived in Notion are archived in the bot.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date
from typing import Optional

from tbl_bot import config
from tbl_bot.models import Idea, Milestone, Task
from tbl_bot.service import Service
from tbl_bot.storage import Storage

from .notion_api import NotionClient, nid, prop_types, read, write

log = logging.getLogger("sync")

TASK_PROPS = {
    "title": "Задача", "stage": "Этап", "type": "Тип", "status": "Статус", "priority": "Приоритет",
    "description": "Описание", "result": "Результат", "assignee_notion": "Исполнитель", "log": "Журнал",
    "milestones": "Веха", "depends_on": "Зависит от", "due": "Срок",
}
TASK_TYPES = {"Задача": "title", "Этап": "select", "Тип": "select", "Статус": "status", "Приоритет": "select",
              "Описание": "rich_text", "Результат": "url", "Исполнитель": "people", "Журнал": "rich_text",
              "Веха": "relation", "Зависит от": "relation", "Срок": "date"}
MS_PROPS = {"title": "Веха", "date": "Дата", "status": "Статус", "criterion": "Критерий"}
MS_TYPES = {"Веха": "title", "Дата": "date", "Статус": "status", "Критерий": "rich_text"}
IDEA_PROPS = {"title": "Идея", "group": "Группа", "queue": "Очередь", "status": "Статус",
              "description": "Описание", "closes": "Что закрывает", "tasks": "Задача"}
IDEA_TYPES = {"Идея": "title", "Группа": "select", "Очередь": "select", "Статус": "status",
              "Описание": "rich_text", "Что закрывает": "rich_text", "Задача": "relation"}


@dataclass
class Report:
    pulled: dict = field(default_factory=dict)
    created: int = 0
    pushed: int = 0
    archived: int = 0
    errors: list = field(default_factory=list)


def _d(v) -> Optional[date]:
    return date.fromisoformat(v[:10]) if v else None


class Syncer:
    def __init__(self, client: NotionClient, st: Storage, now_fn=config.now):
        self.n = client
        self.st = st
        self.now = now_fn
        self.r = Report()
        self.types = {"task": dict(TASK_TYPES), "ms": dict(MS_TYPES), "idea": dict(IDEA_TYPES)}
        self.n2l: dict[str, str] = {}   # Notion page id → bot task id
        self.l2n: dict[str, str] = {}   # bot task id → Notion page id

    # ------------------------------------------------------------------ pull
    def _learn_types(self, key: str, pages: list[dict]) -> None:
        for name, t in prop_types(pages).items():
            if name in self.types[key]:
                self.types[key][name] = t

    def pull_users(self) -> None:
        users = self.n.users()
        for u in users:
            self.st.put("notion_user", u["id"], {"id": u["id"], "name": u.get("name") or "",
                                                "type": u.get("type", "person")})
        self.r.pulled["users"] = len(users)

    def pull_milestones(self) -> None:
        pages = self.n.query(config.NOTION_MILESTONES_DB)
        self._learn_types("ms", pages)
        for p in pages:
            pid = nid(p["id"])
            pr = p["properties"]
            remote = {"title": read(pr.get("Веха")) or "", "date": _d((read(pr.get("Дата")) or (None, None))[0]),
                      "status": read(pr.get("Статус")) or "Впереди", "criterion": read(pr.get("Критерий")) or ""}
            d = self.st.get("milestone", pid)
            m = Milestone.from_dict(d) if d else Milestone(id=pid, title=remote["title"])
            for f, v in remote.items():
                if f not in m.dirty:
                    setattr(m, f, v)
            self.st.save_milestone(m)
        self.r.pulled["milestones"] = len(pages)

    def _parse_task(self, p: dict) -> dict:
        pr = p["properties"]
        s, e = read(pr.get("Срок")) or (None, None)
        start, due = (_d(s), _d(e)) if e else (None, _d(s))
        people = read(pr.get("Исполнитель")) or []
        return {
            "title": read(pr.get("Задача")) or "",
            "stage": read(pr.get("Этап")) or "",
            "type": read(pr.get("Тип")) or "Задача",
            "status": read(pr.get("Статус")) or "Не начато",
            "priority": read(pr.get("Приоритет")) or "Средний",
            "start": start, "due": due,
            "description": read(pr.get("Описание")) or "",
            "result": read(pr.get("Результат")) or "",
            "assignee_notion": people[0] if people else None,
            "log": read(pr.get("Журнал")) or "",
            "milestones": read(pr.get("Веха")) or [],
            "depends_on": [self.n2l.get(x, x) for x in (read(pr.get("Зависит от")) or [])],
        }

    @staticmethod
    def _merge(t: Task, remote: dict, by_notion_user: dict) -> Task:
        dirty = set(t.dirty)
        if "start" in dirty:
            dirty.add("due")
        if "due" in dirty:
            dirty.add("start")
        for f, v in remote.items():
            if f in dirty:
                continue
            if f == "assignee_notion":
                if v != t.assignee_notion:
                    t.assignee_notion = v
                    m = by_notion_user.get(v)
                    t.assignee_tg = m.tg_id if m else None
                continue
            setattr(t, f, v)
        return t

    def pull_tasks(self) -> None:
        pages = self.n.query(config.NOTION_TASKS_DB)
        self._learn_types("task", pages)
        local = self.st.tasks(include_archived=True)
        by_notion = {(t.notion_id or t.id): t for t in local if not t.id.startswith("local-") or t.notion_id}
        for key, t in by_notion.items():
            self.n2l[key] = t.id
        for p in pages:
            self.n2l.setdefault(nid(p["id"]), nid(p["id"]))
        self.l2n = {v: k for k, v in self.n2l.items()}
        users = {m.notion_user_id: m for m in self.st.members() if m.notion_user_id}
        seen = set()
        for p in pages:
            pid = nid(p["id"])
            seen.add(pid)
            remote = self._parse_task(p)
            for _ in range(3):   # optimistic concurrency against the bot writing the same task
                cur = by_notion.get(pid)
                fresh = self.st.task(cur.id) if cur else None
                t = fresh or Task(id=pid, title=remote["title"], notion_id=pid)
                rev = t.rev
                t.notion_id = pid
                t = self._merge(t, remote, users)
                t.notion_edited = p.get("last_edited_time", "")
                t.archived = False
                again = self.st.task(t.id)
                if again is None or again.rev == rev:
                    self.st.save_task(t)
                    break
        for t in local:
            key = t.notion_id or (None if t.id.startswith("local-") else t.id)
            if key and key not in seen and not t.archived:
                t.archived = True
                self.st.save_task(t)
                self.r.archived += 1
        self.r.pulled["tasks"] = len(pages)

    def pull_ideas(self) -> None:
        pages = self.n.query(config.NOTION_IDEAS_DB)
        self._learn_types("idea", pages)
        for p in pages:
            pid = nid(p["id"])
            pr = p["properties"]
            remote = {"title": read(pr.get("Идея")) or "", "group": read(pr.get("Группа")) or "",
                      "queue": read(pr.get("Очередь")) or "", "status": read(pr.get("Статус")) or "Новая",
                      "description": read(pr.get("Описание")) or "", "closes": read(pr.get("Что закрывает")) or "",
                      "tasks": [self.n2l.get(x, x) for x in (read(pr.get("Задача")) or [])]}
            d = self.st.get("idea", pid)
            i = Idea.from_dict(d) if d else Idea(id=pid, title=remote["title"])
            for f, v in remote.items():
                if f not in i.dirty:
                    setattr(i, f, v)
            self.st.save_idea(i)
        self.r.pulled["ideas"] = len(pages)

    # ------------------------------------------------------------------ push
    def _task_value(self, t: Task, f: str):
        if f == "due":
            return (t.start, t.due)
        if f == "assignee_notion":
            return [t.assignee_notion] if t.assignee_notion else []
        if f == "depends_on":
            return [self.l2n[x] for x in t.depends_on if x in self.l2n]
        return getattr(t, f)

    def push_tasks(self) -> None:
        for t in self.st.tasks(include_archived=True):
            if not t.dirty or (t.archived and not t.id.startswith("local-")):
                continue
            fields = ["due" if f == "start" else f for f in t.dirty]
            fields = list(dict.fromkeys(fields))
            snapshot = {f: getattr(t, f) for f in t.dirty}
            props = {}
            for f in fields:
                name = TASK_PROPS.get(f)
                if not name:
                    continue
                v = self._task_value(t, f)
                if not t.notion_id and v in (None, "", [], (None, None)):
                    continue
                props[name] = write(self.types["task"][name], v)
            try:
                if t.notion_id:
                    self.n.update(t.notion_id, props)
                else:
                    page = self.n.create(config.NOTION_TASKS_DB, props)
                    t.notion_id = nid(page["id"])
                    self.n2l[t.notion_id] = t.id
                    self.l2n[t.id] = t.notion_id
                    self.r.created += 1
            except Exception as e:  # keep dirty, try next time
                self.r.errors.append(f"task {t.title}: {e}")
                continue
            fresh = self.st.task(t.id) or t
            fresh.notion_id = t.notion_id
            unresolved = [x for x in fresh.depends_on if x not in self.l2n]
            fresh.dirty = [f for f in fresh.dirty
                           if not (f in snapshot and getattr(fresh, f) == snapshot[f])
                           or (f == "depends_on" and unresolved)]
            self.st.save_task(fresh)
            self.r.pushed += 1

    def push_milestones(self) -> None:
        for m in self.st.milestones():
            if not m.dirty:
                continue
            snap = {f: getattr(m, f) for f in m.dirty}
            props = {}
            for f in m.dirty:
                name = MS_PROPS.get(f)
                if name:
                    v = (m.date, None) if f == "date" else getattr(m, f)
                    props[name] = write(self.types["ms"][name], v)
            try:
                self.n.update(m.id, props)
            except Exception as e:
                self.r.errors.append(f"milestone {m.title}: {e}")
                continue
            d = self.st.get("milestone", m.id)
            fresh = Milestone.from_dict(d) if d else m
            fresh.dirty = [f for f in fresh.dirty if not (f in snap and getattr(fresh, f) == snap[f])]
            self.st.save_milestone(fresh)
            self.r.pushed += 1

    def push_ideas(self) -> None:
        for i in self.st.ideas():
            if not i.dirty:
                continue
            snap = {f: list(v) if isinstance(v, list) else v for f, v in ((f, getattr(i, f)) for f in i.dirty)}
            props, keep = {}, []
            for f in i.dirty:
                name = IDEA_PROPS.get(f)
                if not name:
                    continue
                v = getattr(i, f)
                if f == "tasks":
                    if any(x not in self.l2n and x.startswith("local-") for x in v):
                        keep.append(f)   # task not in Notion yet
                    v = [self.l2n.get(x, x) for x in v if not (x.startswith("local-") and x not in self.l2n)]
                props[name] = write(self.types["idea"][name], v)
            try:
                self.n.update(i.id, props)
            except Exception as e:
                self.r.errors.append(f"idea {i.title}: {e}")
                continue
            d = self.st.get("idea", i.id)
            fresh = Idea.from_dict(d) if d else i
            fresh.dirty = [f for f in fresh.dirty
                           if f in keep or not (f in snap and getattr(fresh, f) == snap[f])]
            self.st.save_idea(fresh)
            self.r.pushed += 1

    # ------------------------------------------------------------------- run
    def run(self) -> Report:
        self.pull_users()
        self.pull_milestones()
        self.pull_tasks()
        self.pull_ideas()
        Service(self.st, self.now).refresh_milestones()
        self.push_tasks()
        self.push_ideas()
        self.push_milestones()
        self.st.kv_set("last_sync", self.now().isoformat(timespec="seconds"))
        return self.r
