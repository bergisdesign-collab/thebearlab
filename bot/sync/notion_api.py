"""Minimal Notion REST client (requests) + property converters."""
from __future__ import annotations

import time
from datetime import date
from typing import Iterable, Optional

import requests

API = "https://api.notion.com/v1"
VERSION = "2022-06-28"
RT_LIMIT = 2000


class NotionClient:
    def __init__(self, token: str, session: Optional[requests.Session] = None):
        self.s = session or requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {token}", "Notion-Version": VERSION,
                               "Content-Type": "application/json"})

    def _req(self, method: str, path: str, **kw) -> dict:
        for attempt in range(6):
            r = self.s.request(method, API + path, timeout=30, **kw)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(float(r.headers.get("Retry-After", 1 + attempt)))
                continue
            if r.status_code >= 400:
                raise RuntimeError(f"Notion {method} {path}: {r.status_code} {r.text[:500]}")
            return r.json()
        raise RuntimeError(f"Notion {method} {path}: too many retries")

    def query(self, db_id: str) -> list[dict]:
        out, cursor = [], None
        while True:
            body = {"page_size": 100}
            if cursor:
                body["start_cursor"] = cursor
            data = self._req("POST", f"/databases/{db_id}/query", json=body)
            out += data["results"]
            if not data.get("has_more"):
                return out
            cursor = data["next_cursor"]

    def users(self) -> list[dict]:
        out, cursor = [], None
        while True:
            params = {"page_size": 100}
            if cursor:
                params["start_cursor"] = cursor
            data = self._req("GET", "/users", params=params)
            out += data["results"]
            if not data.get("has_more"):
                return out
            cursor = data["next_cursor"]

    def update(self, page_id: str, props: dict) -> dict:
        return self._req("PATCH", f"/pages/{page_id}", json={"properties": props})

    def create(self, db_id: str, props: dict) -> dict:
        return self._req("POST", "/pages", json={"parent": {"database_id": db_id}, "properties": props})


# --- reading ----------------------------------------------------------------

def nid(x: str) -> str:
    return (x or "").replace("-", "")


def _plain(rt: list) -> str:
    return "".join(x.get("plain_text", "") for x in rt or [])


def read(prop: Optional[dict]):
    """Notion property → python value (str | list | (start, end) | None)."""
    if not prop:
        return None
    t = prop.get("type")
    v = prop.get(t)
    if t in ("title", "rich_text"):
        return _plain(v)
    if t in ("select", "status"):
        return v["name"] if v else ""
    if t == "multi_select":
        return [x["name"] for x in v or []]
    if t == "date":
        if not v:
            return (None, None)
        return (v.get("start"), v.get("end"))
    if t == "people":
        return [x["id"] for x in v or []]
    if t == "relation":
        return [nid(x["id"]) for x in v or []]
    if t in ("url", "number", "checkbox", "email", "phone_number"):
        return v
    return None


# --- writing ----------------------------------------------------------------

def _chunks(text: str) -> list[dict]:
    text = text or ""
    return [{"type": "text", "text": {"content": text[i:i + RT_LIMIT]}} for i in range(0, len(text), RT_LIMIT)][:100]


def write(ptype: str, value) -> dict:
    """python value → Notion property payload for a property of type `ptype`."""
    if ptype == "title":
        return {"title": _chunks(value)}
    if ptype == "rich_text":
        return {"rich_text": _chunks(value)}
    if ptype == "select":
        return {"select": {"name": value} if value else None}
    if ptype == "status":
        return {"status": {"name": value} if value else None}
    if ptype == "url":
        return {"url": value or None}
    if ptype == "people":
        return {"people": [{"id": x} for x in value or []]}
    if ptype == "relation":
        return {"relation": [{"id": x} for x in value or []]}
    if ptype == "date":
        start, end = value
        if not start and not end:
            return {"date": None}
        s = start or end
        d = {"start": s.isoformat() if isinstance(s, date) else s}
        if start and end and start != end:
            d["end"] = end.isoformat() if isinstance(end, date) else end
        return {"date": d}
    raise ValueError(f"unsupported property type {ptype}")


def prop_types(pages: Iterable[dict]) -> dict[str, str]:
    types: dict[str, str] = {}
    for p in pages:
        for name, prop in p.get("properties", {}).items():
            types.setdefault(name, prop.get("type"))
    return types
