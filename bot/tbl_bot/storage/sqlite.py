from __future__ import annotations

import json
import sqlite3
import threading
from typing import Iterable, Optional

from ..models import Event
from . import Storage, dumps


class SqliteStorage(Storage):
    """Local backend for development (`python run_polling.py`) and tests."""

    def __init__(self, path: str = ":memory:"):
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute("CREATE TABLE IF NOT EXISTS entities (kind TEXT, id TEXT, data TEXT, PRIMARY KEY(kind, id))")
            self._db.execute("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, ts TEXT, task_id TEXT, data TEXT)")
            self._db.commit()

    def get(self, kind: str, id: str) -> Optional[dict]:
        with self._lock:
            r = self._db.execute("SELECT data FROM entities WHERE kind=? AND id=?", (kind, id)).fetchone()
        return json.loads(r[0]) if r else None

    def all(self, kind: str) -> list[dict]:
        return [d for _, d in self._all_with_ids(kind)]

    def _all_with_ids(self, kind: str) -> Iterable[tuple[str, dict]]:
        with self._lock:
            rows = self._db.execute("SELECT id, data FROM entities WHERE kind=? ORDER BY id", (kind,)).fetchall()
        return [(i, json.loads(d)) for i, d in rows]

    def put(self, kind: str, id: str, data: dict) -> None:
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO entities (kind, id, data) VALUES (?,?,?)", (kind, id, dumps(data)))
            self._db.commit()

    def delete(self, kind: str, id: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM entities WHERE kind=? AND id=?", (kind, id))
            self._db.commit()

    def add_event(self, ev: Event) -> None:
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO events (id, ts, task_id, data) VALUES (?,?,?,?)",
                             (ev.id, ev.ts, ev.task_id, dumps(ev.to_dict())))
            self._db.commit()

    def events(self, since_iso: str = "", task_id: str = "") -> list[Event]:
        q, args = "SELECT data FROM events WHERE ts >= ?", [since_iso]
        if task_id:
            q += " AND task_id = ?"
            args.append(task_id)
        with self._lock:
            rows = self._db.execute(q + " ORDER BY ts", args).fetchall()
        return [Event.from_dict(json.loads(r[0])) for r in rows]
