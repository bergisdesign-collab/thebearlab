"""YDB (Yandex Database, serverless) backend.

Credentials come from the environment via ydb.credentials_from_env_variables():
  * inside Yandex Cloud Functions: YDB_METADATA_CREDENTIALS=1 (function's service account);
  * in GitHub Actions: YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS=/path/to/key.json.
"""
from __future__ import annotations

import json
from typing import Iterable, Optional

import ydb

from ..models import Event
from . import Storage, dumps

U = ydb.PrimitiveType.Utf8
J = ydb.PrimitiveType.Json

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS entities (
        kind Utf8 NOT NULL, id Utf8 NOT NULL, data Json,
        PRIMARY KEY (kind, id))""",
    """CREATE TABLE IF NOT EXISTS events (
        id Utf8 NOT NULL, ts Utf8, task_id Utf8, data Json,
        PRIMARY KEY (id))""",
]


class YdbStorage(Storage):
    def __init__(self, endpoint: str, database: str):
        self._driver = ydb.Driver(endpoint=endpoint, database=database,
                                  credentials=ydb.credentials_from_env_variables())
        self._driver.wait(timeout=15, fail_fast=True)
        self._pool = ydb.QuerySessionPool(self._driver)

    def ensure_schema(self) -> None:
        for ddl in SCHEMA:
            self._pool.execute_with_retries(ddl)

    def close(self) -> None:
        self._pool.stop()
        self._driver.stop()

    # --- helpers ----------------------------------------------------------
    def _rows(self, query: str, params: dict) -> list:
        result_sets = self._pool.execute_with_retries(query, params)
        rows = []
        for rs in result_sets:
            rows.extend(rs.rows)
        return rows

    @staticmethod
    def _json(v) -> dict:
        if v is None:
            return {}
        return json.loads(v) if isinstance(v, (str, bytes)) else v

    # --- primitives -------------------------------------------------------
    def get(self, kind: str, id: str) -> Optional[dict]:
        rows = self._rows(
            "DECLARE $kind AS Utf8; DECLARE $id AS Utf8;"
            "SELECT data FROM entities WHERE kind = $kind AND id = $id;",
            {"$kind": (kind, U), "$id": (id, U)})
        return self._json(rows[0]["data"]) if rows else None

    def all(self, kind: str) -> list[dict]:
        return [d for _, d in self._all_with_ids(kind)]

    def _all_with_ids(self, kind: str) -> Iterable[tuple[str, dict]]:
        rows = self._rows(
            "DECLARE $kind AS Utf8; SELECT id, data FROM entities WHERE kind = $kind ORDER BY id;",
            {"$kind": (kind, U)})
        return [(r["id"], self._json(r["data"])) for r in rows]

    def put(self, kind: str, id: str, data: dict) -> None:
        self._pool.execute_with_retries(
            "DECLARE $kind AS Utf8; DECLARE $id AS Utf8; DECLARE $data AS Json;"
            "UPSERT INTO entities (kind, id, data) VALUES ($kind, $id, $data);",
            {"$kind": (kind, U), "$id": (id, U), "$data": (dumps(data), J)})

    def delete(self, kind: str, id: str) -> None:
        self._pool.execute_with_retries(
            "DECLARE $kind AS Utf8; DECLARE $id AS Utf8;"
            "DELETE FROM entities WHERE kind = $kind AND id = $id;",
            {"$kind": (kind, U), "$id": (id, U)})

    def add_event(self, ev: Event) -> None:
        self._pool.execute_with_retries(
            "DECLARE $id AS Utf8; DECLARE $ts AS Utf8; DECLARE $task AS Utf8; DECLARE $data AS Json;"
            "UPSERT INTO events (id, ts, task_id, data) VALUES ($id, $ts, $task, $data);",
            {"$id": (ev.id, U), "$ts": (ev.ts, U), "$task": (ev.task_id, U), "$data": (dumps(ev.to_dict()), J)})

    def events(self, since_iso: str = "", task_id: str = "") -> list[Event]:
        if task_id:
            rows = self._rows(
                "DECLARE $since AS Utf8; DECLARE $task AS Utf8;"
                "SELECT data FROM events WHERE ts >= $since AND task_id = $task ORDER BY ts;",
                {"$since": (since_iso, U), "$task": (task_id, U)})
        else:
            rows = self._rows(
                "DECLARE $since AS Utf8; SELECT data FROM events WHERE ts >= $since ORDER BY ts;",
                {"$since": (since_iso, U)})
        return [Event.from_dict(self._json(r["data"])) for r in rows]
