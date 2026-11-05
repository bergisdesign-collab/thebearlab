"""Firestore backend (Google Cloud, free tier: 50k reads / 20k writes per day).

To stay far below the free quota, each kind is ONE document holding a map of items:
    {prefix}/task      → {"items": {"<id>": {...task...}, ...}}
    {prefix}/milestone, idea, member, notion_user, kv, day
Reading every task is one read; changing one task is one field-level update.
Task history goes to a separate collection ({prefix}_events), one document per event.

Reads are cached until `begin()` (start of each request) or `refresh(kind)`.
A kind document must stay under Firestore's 1 MiB limit — fine for hundreds of tasks.
Credentials: Application Default Credentials (the Cloud Run service account),
or FIRESTORE_EMULATOR_HOST for tests.
"""
from __future__ import annotations

import os
import threading
from typing import Iterable, Optional

from google.api_core.exceptions import NotFound
from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from google.cloud.firestore_v1.field_path import FieldPath

from ..models import Event
from . import Storage


class FirestoreStorage(Storage):
    def __init__(self, prefix: str = "tbl", client: Optional[firestore.Client] = None):
        self.db = client or firestore.Client(project=os.environ.get("GOOGLE_CLOUD_PROJECT") or None)
        self.col = self.db.collection(prefix)
        self.events_col = self.db.collection(f"{prefix}_events")
        self._cache: dict[str, dict] = {}
        self._lock = threading.Lock()

    # --- cache --------------------------------------------------------------
    def begin(self) -> None:
        with self._lock:
            self._cache.clear()

    def refresh(self, kind: str) -> None:
        with self._lock:
            self._cache.pop(kind, None)

    def _items(self, kind: str) -> dict:
        with self._lock:
            if kind in self._cache:
                return self._cache[kind]
        snap = self.col.document(kind).get()
        items = (snap.to_dict() or {}).get("items", {}) if snap.exists else {}
        with self._lock:
            self._cache[kind] = items
        return items

    # --- primitives -----------------------------------------------------------
    def get(self, kind: str, id: str) -> Optional[dict]:
        d = self._items(kind).get(id)
        return dict(d) if d is not None else None

    def all(self, kind: str) -> list[dict]:
        return [d for _, d in self._all_with_ids(kind)]

    def _all_with_ids(self, kind: str) -> Iterable[tuple[str, dict]]:
        items = self._items(kind)
        return [(k, dict(items[k])) for k in sorted(items)]

    def put(self, kind: str, id: str, data: dict) -> None:
        ref = self.col.document(kind)
        try:
            ref.update({FieldPath("items", id).to_api_repr(): data})
        except NotFound:
            ref.set({"items": {id: data}}, merge=True)
        with self._lock:
            if kind in self._cache:
                self._cache[kind][id] = data

    def delete(self, kind: str, id: str) -> None:
        try:
            self.col.document(kind).update({FieldPath("items", id).to_api_repr(): firestore.DELETE_FIELD})
        except NotFound:
            pass
        with self._lock:
            if kind in self._cache:
                self._cache[kind].pop(id, None)

    def add_event(self, ev: Event) -> None:
        self.events_col.document(ev.id).set(ev.to_dict())

    def events(self, since_iso: str = "", task_id: str = "") -> list[Event]:
        # Single-field filters only, so no composite index has to be created.
        if task_id:
            q = self.events_col.where(filter=FieldFilter("task_id", "==", task_id))
            evs = [Event.from_dict(d.to_dict()) for d in q.stream()]
            evs = [e for e in evs if e.ts >= since_iso]
        else:
            q = self.events_col.where(filter=FieldFilter("ts", ">=", since_iso))
            evs = [Event.from_dict(d.to_dict()) for d in q.stream()]
        return sorted(evs, key=lambda e: e.ts)
