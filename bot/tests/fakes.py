"""Fake Notion API (same page/property JSON shapes as the real one) and fixtures."""
from __future__ import annotations

import copy
import itertools
from datetime import datetime

from tbl_bot import config
from tbl_bot.config import TZ

NOW = datetime(2026, 11, 5, 9, 0, tzinfo=TZ)
_ids = itertools.count(1)


def new_id() -> str:
    return f"{next(_ids):032x}"


def dash(i: str) -> str:   # Notion returns dashed UUIDs
    return f"{i[:8]}-{i[8:12]}-{i[12:16]}-{i[16:20]}-{i[20:]}"


def P(ptype: str, value) -> dict:
    """Build a property as Notion returns it."""
    if ptype in ("title", "rich_text"):
        return {"type": ptype, ptype: [{"plain_text": value or "", "text": {"content": value or ""}}] if value else []}
    if ptype in ("select", "status"):
        return {"type": ptype, ptype: {"name": value} if value else None}
    if ptype == "date":
        if not value:
            return {"type": "date", "date": None}
        s, e = value if isinstance(value, tuple) else (value, None)
        return {"type": "date", "date": {"start": s, "end": e}}
    if ptype == "people":
        return {"type": "people", "people": [{"id": x} for x in value or []]}
    if ptype == "relation":
        return {"type": "relation", "relation": [{"id": dash(x)} for x in value or []]}
    if ptype == "url":
        return {"type": "url", "url": value}
    raise ValueError(ptype)


class FakeNotion:
    def __init__(self):
        self.dbs = {config.NOTION_TASKS_DB: {}, config.NOTION_MILESTONES_DB: {}, config.NOTION_IDEAS_DB: {}}
        self.users_list = [{"id": "aaaaaaaa-0000-0000-0000-000000000001", "name": "Сергей", "type": "person"},
                           {"id": "aaaaaaaa-0000-0000-0000-000000000002", "name": "Аня", "type": "person"},
                           {"id": "bbbbbbbb-0000-0000-0000-000000000009", "name": "Integration", "type": "bot"}]
        self.calls = []
        self.clock = itertools.count(1)

    # --- seeding helpers -----------------------------------------------------
    def add(self, db: str, props: dict, pid: str = "") -> str:
        pid = pid or new_id()
        self.dbs[db][pid] = {"id": dash(pid), "properties": props,
                             "last_edited_time": f"2026-11-01T00:00:{next(self.clock) % 60:02d}.000Z"}
        return pid

    def page(self, pid: str) -> dict:
        for db in self.dbs.values():
            if pid in db:
                return db[pid]
        raise KeyError(pid)

    def edit(self, pid: str, name: str, prop: dict) -> None:   # a human editing in Notion
        pg = self.page(pid)
        pg["properties"][name] = prop
        pg["last_edited_time"] = f"2026-11-05T10:{next(self.clock) % 60:02d}:00.000Z"

    # --- API surface used by Syncer -----------------------------------------
    def query(self, db_id):
        self.calls.append(("query", db_id))
        return [copy.deepcopy(p) for p in self.dbs[db_id].values()]

    def users(self):
        return copy.deepcopy(self.users_list)

    @staticmethod
    def _to_read(payload: dict) -> dict:
        (ptype, v), = payload.items()
        if ptype in ("title", "rich_text"):
            return {"type": ptype, ptype: [{"plain_text": c["text"]["content"]} for c in v]}
        if ptype == "relation":
            return {"type": ptype, ptype: [{"id": dash(x["id"]) if len(x["id"]) == 32 else x["id"]} for x in v]}
        return {"type": ptype, ptype: v}

    def update(self, page_id, props):
        self.calls.append(("update", page_id, props))
        pg = self.page(page_id.replace("-", ""))
        for name, payload in props.items():
            pg["properties"][name] = self._to_read(payload)
        return pg

    def create(self, db_id, props):
        self.calls.append(("create", db_id, props))
        pid = new_id()
        full = {name: self._to_read(payload) for name, payload in props.items()}
        self.dbs[db_id][pid] = {"id": dash(pid), "properties": full, "last_edited_time": "2026-11-05T09:00:00.000Z"}
        return self.dbs[db_id][pid]


def task_props(title, stage="1. Концепция игры", status="Не начато", priority="Средний", due=None,
               typ="Задача", ms=(), deps=(), people=(), desc=""):
    return {"Задача": P("title", title), "Этап": P("select", stage), "Тип": P("select", typ),
            "Статус": P("status", status), "Приоритет": P("select", priority), "Срок": P("date", due),
            "Описание": P("rich_text", desc), "Исполнитель": P("people", list(people)),
            "Веха": P("relation", list(ms)), "Зависит от": P("relation", list(deps)),
            "Результат": P("url", None), "Журнал": P("rich_text", "")}


def seed(fn: FakeNotion) -> dict:
    """A small roadmap shaped like the real one."""
    M, T, I = config.NOTION_MILESTONES_DB, config.NOTION_TASKS_DB, config.NOTION_IDEAS_DB
    ids = {}
    ids["ms_ny"] = fn.add(M, {"Веха": P("title", "Решение по Новому году"), "Дата": P("date", "2026-11-12"),
                              "Статус": P("status", "Впереди"), "Критерий": P("rich_text", "Решение принято")})
    ids["ms_launch"] = fn.add(M, {"Веха": P("title", "Запуск продаж"), "Дата": P("date", "2027-02-05"),
                                  "Статус": P("status", "Впереди"), "Критерий": P("rich_text", "")})
    ids["t_decide"] = fn.add(T, task_props("Решить, успеваем ли к Новому году", typ="Решение", priority="Высокий",
                                           due="2026-11-10", ms=[ids["ms_ny"]]))
    ids["t_gdd"] = fn.add(T, task_props("Написать гейм-диздок", priority="Высокий", due="2026-11-03",
                                        people=["aaaaaaaa-0000-0000-0000-000000000002"]))
    ids["t_after"] = fn.add(T, task_props("Утвердить гейм-диздок", deps=[ids["t_gdd"]], due="2026-11-20"))
    ids["t_fabric"] = fn.add(T, task_props("Найти поставщика ткани", stage="4. Производство", due="2026-11-30",
                                           desc="Плюш, мех, сертификаты"))
    ids["t_done"] = fn.add(T, task_props("Собрать референсы", stage="2. Поиск концепта", status="Готово",
                                         ms=[ids["ms_ny"]]))
    ids["idea"] = fn.add(I, {"Идея": P("title", "Паспорт мишки"), "Группа": P("select", "Эмоции"),
                             "Очередь": P("select", "MVP"), "Статус": P("status", "Новая"),
                             "Описание": P("rich_text", "Карточка с именем"), "Что закрывает": P("rich_text", "Привязанность"),
                             "Задача": P("relation", [])})
    return ids
