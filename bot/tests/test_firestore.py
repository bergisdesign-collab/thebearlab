"""Runs against the Firestore emulator (CI job `firestore`). Skipped locally without FIRESTORE_EMULATOR_HOST."""
from __future__ import annotations

import os
import uuid

import pytest

if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
    pytest.skip("Firestore emulator is not running", allow_module_level=True)

from google.cloud import firestore  # noqa: E402

from sync.sync import Syncer  # noqa: E402
from tbl_bot.app import App, Who  # noqa: E402
from tbl_bot.models import Event  # noqa: E402
from tbl_bot.storage.firestore_store import FirestoreStorage  # noqa: E402

from .fakes import NOW, FakeNotion, seed  # noqa: E402


@pytest.fixture
def fs():
    client = firestore.Client(project="demo-tbl")
    return FirestoreStorage(prefix="t" + uuid.uuid4().hex[:8], client=client)


def test_primitives(fs):
    assert fs.get("kv", "x") is None
    fs.put("kv", "await:1", {"v": {"a": "new", "title": "T"}})
    fs.put("kv", "await:1", {"v": {"a": "due"}})            # whole value replaced, not merged
    fs.begin()
    assert fs.get("kv", "await:1") == {"v": {"a": "due"}}
    fs.put("task", "40fccd0734e1811883cdf43aa42f52a9", {"id": "40fc", "title": "digits first"})
    fs.put("task", "local-ab.c", {"id": "local-ab.c", "title": "dot and dash"})
    fs.begin()
    assert [d["title"] for d in fs.all("task")] == ["digits first", "dot and dash"]
    fs.delete("task", "local-ab.c")
    fs.begin()
    assert len(fs.all("task")) == 1
    for i, tid in enumerate(["a", "b", "a"]):
        fs.add_event(Event(id=f"e{i}", ts=f"2026-11-0{i + 1}T10:00:00+03:00", task_id=tid, actor="X", kind="note", text=str(i)))
    assert [e.text for e in fs.events(task_id="a")] == ["0", "2"]
    assert [e.text for e in fs.events("2026-11-02")] == ["1", "2"]


def test_full_flow_on_firestore(fs):
    fn = FakeNotion()
    ids = seed(fn)
    Syncer(fn, fs, lambda: NOW).run()
    fs.begin()
    assert len(fs.tasks()) == 5
    app = App(fs, lambda: NOW)
    me = Who(7, "Сергей")
    app.start(me)
    fs.begin()
    app.on_callback(me, 7, f"t:take:{ids['t_fabric']}")
    other = FirestoreStorage(prefix=fs.col.id, client=fs.db)   # a second instance sees the change
    assert other.task(ids["t_fabric"]).assignee_tg == 7
    s = Syncer(fn, other, lambda: NOW)
    assert s.has_local_changes()
    s.push()
    fs.begin()
    assert not fs.task(ids["t_fabric"]).dirty
