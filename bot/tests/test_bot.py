from __future__ import annotations

from datetime import date, timedelta

import pytest

from sync.sync import Syncer
from tbl_bot import jobs, logic
from tbl_bot.app import App, Who
from tbl_bot.models import Milestone, Task
from tbl_bot.storage.sqlite import SqliteStorage

from .fakes import NOW, FakeNotion, P, seed

SERGEY = Who(1001, "Сергей", "sergey")
ANYA = Who(1002, "Аня", "anya")
GROUP = -100500


@pytest.fixture
def env():
    st = SqliteStorage(":memory:")
    fn = FakeNotion()
    ids = seed(fn)
    Syncer(fn, st, lambda: NOW).run()
    app = App(st, lambda: NOW)
    return st, fn, ids, app


def team(app):
    app.start(SERGEY)
    r = app.start(ANYA)
    assert "Заявка отправлена" in r.screen.text
    assert r.notices and r.notices[0].chat_id == SERGEY.id
    app.on_callback(SERGEY, SERGEY.id, f"m:ok:{ANYA.id}")
    app.on_command(SERGEY, GROUP, False, "bindchat")


def all_buttons(screen):
    return [b for row in screen.kb for b in row]


# ---------------------------------------------------------------- logic

def test_progress_and_bar():
    ts = [Task(id="a", title="a", status="Готово"), Task(id="b", title="b")]
    assert logic.progress(ts) == (1, 2, 50)
    assert logic.bar(50, 10) == "▰" * 5 + "▱" * 5


def test_streak_counts_clean_days_and_skips_holidays():
    days = {"2026-12-29": {"overdue": 0}, "2026-12-30": {"overdue": 0}, "2026-12-31": {"overdue": 0},
            "2027-01-12": {"overdue": 0}, "2027-01-13": {"overdue": 0}}
    assert logic.streak(days, date(2027, 1, 13)) == 5
    days["2026-12-30"]["overdue"] = 2
    assert logic.streak(days, date(2027, 1, 13)) == 3
    assert logic.streak({}, date(2027, 1, 13)) == 0


def test_deadline_never_on_holidays():
    assert logic.skip_holidays(date(2027, 1, 5)) == date(2027, 1, 12)
    assert logic.skip_holidays(date(2026, 12, 30)) == date(2026, 12, 30)


def test_parse_date():
    t = date(2026, 11, 5)
    assert logic.parse_date("15.11", t) == date(2026, 11, 15)
    assert logic.parse_date("10.01", t) == date(2027, 1, 10)
    assert logic.parse_date("+3", t) == date(2026, 11, 8)
    assert logic.parse_date("завтра", t) == date(2026, 11, 6)
    assert logic.parse_date("2026-12-01", t) == date(2026, 12, 1)
    assert logic.parse_date("ерунда", t) is None
    assert logic.parse_date("31.02", t) is None


def test_mentor_respects_dependencies_and_explains(env):
    st, fn, ids, app = env
    sug = logic.suggest(st.tasks(), st.milestones(), None, NOW.date(), limit=10)
    titles = [t.title for t, _, _ in sug]
    assert "Утвердить гейм-диздок" not in titles          # waits for an open dependency
    assert "Написать гейм-диздок" not in titles           # assigned to someone in Notion
    top, _, reasons = sug[0]
    assert top.title == "Решить, успеваем ли к Новому году"
    assert any("веха" in r for r in reasons) and "нужно принять решение" in reasons


def test_search_stems_russian():
    ts = [Task(id="a", title="Найти поставщика ткани")]
    assert logic.search("ткань", ts, [])[0][1].id == "a"


def test_milestone_status():
    today = date(2026, 11, 5)
    m = Milestone(id="m", title="M", date=date(2026, 11, 10))
    late = Task(id="a", title="a", due=date(2026, 11, 1), milestones=["m"])
    ok = Task(id="b", title="b", status="Готово", milestones=["m"])
    assert logic.milestone_status(m, [late, ok], today) == "Под угрозой"
    late.status = "Готово"
    assert logic.milestone_status(m, [late, ok], today) == "Достигнута"


# ---------------------------------------------------------------- access

def test_first_user_is_admin_others_need_approval(env):
    st, fn, ids, app = env
    r = app.start(SERGEY)
    assert "администратор" in r.screen.text
    app.start(ANYA)
    r = app.on_command(ANYA, ANYA.id, True, "my")
    assert "/start" in r.screen.text                       # not approved yet
    r = app.on_callback(ANYA, ANYA.id, f"m:ok:{ANYA.id}")
    assert r.alert                                         # cannot approve herself
    r = app.on_callback(SERGEY, SERGEY.id, f"m:ok:{ANYA.id}")
    assert r.notices[0].chat_id == ANYA.id
    assert st.member(ANYA.id).approved


# ---------------------------------------------------------------- tasks

def test_take_release_history_and_broadcast(env):
    st, fn, ids, app = env
    team(app)
    tid = ids["t_fabric"]
    r = app.on_callback(ANYA, ANYA.id, f"t:take:{tid}")
    t = st.task(tid)
    assert t.assignee_tg == ANYA.id and t.status == "В работе"
    assert {"assignee_notion", "status", "log"} <= set(t.dirty)
    assert "Аня: взята в работу" in t.log
    assert any(n.chat_id == GROUP and "Аня" in n.text for n in r.notices)

    r = app.on_callback(SERGEY, SERGEY.id, f"t:take:{tid}")
    assert r.alert and "Аня" in r.toast                    # someone else's task

    r = app.on_callback(SERGEY, SERGEY.id, f"t:to:{tid}:{SERGEY.id}")
    assert st.task(tid).assignee_tg == SERGEY.id
    assert any(n.chat_id == ANYA.id for n in r.notices)    # previous owner is told

    r = app.on_callback(SERGEY, SERGEY.id, f"t:log:{tid}")
    assert "взята в работу" in r.screen.text and "назначена на Сергей" in r.screen.text


def test_result_moves_to_review_and_status_done(env):
    st, fn, ids, app = env
    team(app)
    tid = ids["t_decide"]
    app.on_callback(SERGEY, SERGEY.id, f"t:res:{tid}")
    app.on_text(SERGEY, SERGEY.id, True, "https://docs.example/decision")
    t = st.task(tid)
    assert t.result == "https://docs.example/decision" and t.status == "На проверке"
    r = app.on_callback(ANYA, ANYA.id, f"t:st:{tid}:3")
    assert st.task(tid).done
    assert any("✅" in n.text for n in r.notices if n.chat_id == GROUP)
    assert st.events(task_id=tid)[-1].kind == "done"


def test_postpone_and_custom_date(env):
    st, fn, ids, app = env
    team(app)
    tid = ids["t_fabric"]
    app.on_callback(SERGEY, SERGEY.id, f"t:dd:{tid}:3")
    assert st.task(tid).due == date(2026, 12, 3)
    app.on_callback(SERGEY, SERGEY.id, f"t:date:{tid}")
    r = app.on_text(SERGEY, SERGEY.id, True, "05.01")      # lands on holidays → moved
    assert st.task(tid).due == date(2027, 1, 12)
    app.on_callback(SERGEY, SERGEY.id, f"t:date:{tid}")
    app.on_text(SERGEY, SERGEY.id, True, "нет")
    assert st.task(tid).due is None


def test_new_task_wizard(env):
    st, fn, ids, app = env
    team(app)
    r = app.on_command(SERGEY, SERGEY.id, True, "new")
    app.on_text(SERGEY, SERGEY.id, True, "Сделать прайс-лист")
    app.on_callback(SERGEY, SERGEY.id, "n:st:2")
    app.on_callback(SERGEY, SERGEY.id, "n:pr:Высокий")
    r = app.on_callback(SERGEY, SERGEY.id, "n:due:7")
    assert r.new_message and "Сделать прайс-лист" in r.screen.text
    t = [x for x in st.tasks() if x.title == "Сделать прайс-лист"][0]
    assert t.id.startswith("local-") and t.stage == "3. Маркетинг" and t.priority == "Высокий"
    assert t.due == date(2026, 11, 12)
    assert st.kv_get(f"await:{SERGEY.id}") is None


def test_free_text_is_search_and_commands_cancel_input(env):
    st, fn, ids, app = env
    team(app)
    r = app.on_text(ANYA, ANYA.id, True, "ткань")
    assert any(b.data == f"t:v:{ids['t_fabric']}" for b in all_buttons(r.screen))
    app.on_callback(ANYA, ANYA.id, f"t:note:{ids['t_fabric']}")
    app.on_command(ANYA, ANYA.id, True, "my")
    r = app.on_text(ANYA, ANYA.id, True, "паспорт")
    assert any(b.data.startswith("i:v:") for b in all_buttons(r.screen))
    assert app.on_text(ANYA, GROUP, False, "привет") is None   # group chatter ignored


def test_every_screen_renders_with_valid_buttons(env):
    st, fn, ids, app = env
    team(app)
    seen, queue = set(), ["go:menu"]
    for cmd in ("today", "my", "next", "free", "tasks", "plan", "milestones", "ideas", "team", "help", "sync"):
        r = app.on_command(SERGEY, SERGEY.id, True, cmd)
        assert r.screen and len(r.screen.text) < 4096
        queue += [b.data for b in all_buttons(r.screen) if b.data]
    while queue:
        data = queue.pop()
        if data in seen or data.split(":")[1] in ("take", "rel", "to", "st", "dd", "ok", "no", "ps", "rej", "ln"):
            continue
        seen.add(data)
        r = app.on_callback(SERGEY, SERGEY.id, data)
        assert "устарела" not in r.toast, data
        if r.screen:
            assert len(r.screen.text) < 4096
            for b in all_buttons(r.screen):
                assert b.url or 0 < len(b.data.encode()) <= 64, b
                if b.data:
                    queue.append(b.data)
    assert len(seen) > 20


# ---------------------------------------------------------------- ideas & team

def test_idea_becomes_task_and_relation_reaches_notion(env):
    st, fn, ids, app = env
    team(app)
    app.on_callback(SERGEY, SERGEY.id, f"i:ps:{ids['idea']}:5")
    t = [x for x in st.tasks() if x.title == "Паспорт мишки"][0]
    assert "Что закрывает" in t.description and t.stage == "6. Приложение"
    Syncer(fn, st, lambda: NOW).run()
    t = st.task(t.id)
    assert t.notion_id and not t.dirty
    idea_page = fn.page(ids["idea"])
    assert idea_page["properties"]["Статус"]["status"]["name"] == "В задачах"
    assert [r["id"].replace("-", "") for r in idea_page["properties"]["Задача"]["relation"]] == [t.notion_id]
    assert not st.idea(ids["idea"]).dirty


def test_link_member_to_notion_user(env):
    st, fn, ids, app = env
    team(app)
    r = app.on_callback(ANYA, ANYA.id, f"m:link:{ANYA.id}")
    assert all("Integration" not in b.text for b in all_buttons(r.screen))   # bots hidden
    app.on_callback(ANYA, ANYA.id, f"m:ln:{ANYA.id}:aaaaaaaa000000000000000000000002")
    # task assigned to Аня in Notion now belongs to her Telegram account
    assert st.task(ids["t_gdd"]).assignee_tg == ANYA.id
    r = app.on_command(ANYA, ANYA.id, True, "my")
    assert "Мои задачи (1)" in r.screen.text


# ---------------------------------------------------------------- sync

def test_initial_pull(env):
    st, fn, ids, app = env
    assert len(st.tasks()) == 5 and len(st.milestones()) == 2 and len(st.ideas()) == 1
    t = st.task(ids["t_after"])
    assert t.depends_on == [ids["t_gdd"]] and t.due == date(2026, 11, 20)
    assert st.kv_get("last_sync")


def test_bot_change_pushed_and_notion_change_pulled(env):
    st, fn, ids, app = env
    team(app)
    app.on_callback(SERGEY, SERGEY.id, f"t:dd:{ids['t_fabric']}:1")
    fn.edit(ids["t_fabric"], "Описание", P("rich_text", "Новое описание из Notion"))
    Syncer(fn, st, lambda: NOW).run()
    t = st.task(ids["t_fabric"])
    assert t.description == "Новое описание из Notion"
    assert fn.page(ids["t_fabric"])["properties"]["Срок"]["date"]["start"] == "2026-12-01"
    assert not t.dirty
    assert "срок" in fn.page(ids["t_fabric"])["properties"]["Журнал"]["rich_text"][0]["plain_text"]


def test_conflict_bot_dirty_field_wins(env):
    st, fn, ids, app = env
    team(app)
    app.on_callback(SERGEY, SERGEY.id, f"t:st:{ids['t_fabric']}:1")
    fn.edit(ids["t_fabric"], "Статус", P("status", "На проверке"))
    Syncer(fn, st, lambda: NOW).run()
    assert st.task(ids["t_fabric"]).status == "В работе"
    assert fn.page(ids["t_fabric"])["properties"]["Статус"]["status"]["name"] == "В работе"


def test_local_task_created_in_notion_once(env):
    st, fn, ids, app = env
    team(app)
    app.on_command(SERGEY, SERGEY.id, True, "new", "Купить образцы")
    app.on_callback(SERGEY, SERGEY.id, "n:st:3")
    app.on_callback(SERGEY, SERGEY.id, "n:pr:Средний")
    app.on_callback(SERGEY, SERGEY.id, "n:due:0")
    Syncer(fn, st, lambda: NOW).run()
    Syncer(fn, st, lambda: NOW).run()
    creates = [c for c in fn.calls if c[0] == "create"]
    assert len(creates) == 1
    assert sum(1 for t in st.tasks() if t.title == "Купить образцы") == 1


def test_deleted_page_is_archived(env):
    st, fn, ids, app = env
    del fn.dbs[list(fn.dbs)[0]][ids["t_fabric"]]
    Syncer(fn, st, lambda: NOW).run()
    assert st.task(ids["t_fabric"]).archived
    assert ids["t_fabric"] not in [t.id for t in st.tasks()]


def test_assignee_from_unlinked_member_survives_sync(env):
    st, fn, ids, app = env
    team(app)                                   # nobody linked to Notion yet
    app.on_callback(ANYA, ANYA.id, f"t:take:{ids['t_fabric']}")
    Syncer(fn, st, lambda: NOW).run()
    Syncer(fn, st, lambda: NOW).run()
    assert st.task(ids["t_fabric"]).assignee_tg == ANYA.id


def test_milestone_status_pushed(env):
    st, fn, ids, app = env
    later = NOW + timedelta(days=4)            # 9 Nov: 3 days to «Новый год» milestone, 1/2 done
    Syncer(fn, st, lambda: later).run()
    assert fn.page(ids["ms_ny"])["properties"]["Статус"]["status"]["name"] == "Под угрозой"


# ---------------------------------------------------------------- jobs

def test_morning_digest(env):
    st, fn, ids, app = env
    team(app)
    app.on_callback(ANYA, ANYA.id, f"t:take:{ids['t_decide']}")
    out = jobs.run("morning", st, lambda: NOW)
    group = [n for n in out if n.chat_id == GROUP]
    assert group and "Просрочено" in group[0].text and "Написать гейм-диздок" in group[0].text
    assert "До запуска продаж" in group[0].text
    anya = [n for n in out if n.chat_id == ANYA.id][0]
    assert "Решить, успеваем" in anya.text


def test_evening_only_when_needed_and_weekly(env):
    st, fn, ids, app = env
    team(app)
    out = jobs.run("evening", st, lambda: NOW)
    assert not [n for n in out if n.chat_id in (SERGEY.id, ANYA.id)]
    app.on_callback(ANYA, ANYA.id, f"t:st:{ids['t_decide']}:3")
    w = jobs.run("weekly", st, lambda: NOW)
    assert "Закрыто за неделю: 1" in w[0].text


def test_no_jobs_on_holidays(env):
    st, fn, ids, app = env
    team(app)
    from datetime import datetime
    from tbl_bot.config import TZ
    assert jobs.run("morning", st, lambda: datetime(2027, 1, 3, 9, tzinfo=TZ)) == []


# ---------------------------------------------------------------- scheduling & write economy

def test_jobs_due_once_per_day(env):
    from datetime import datetime
    from tbl_bot.config import TZ
    st = env[0]
    fri = datetime(2026, 11, 6, 18, 5, tzinfo=TZ)
    assert jobs.due(st, datetime(2026, 11, 6, 8, 55, tzinfo=TZ)) == []
    assert jobs.due(st, datetime(2026, 11, 6, 9, 3, tzinfo=TZ)) == ["morning"]
    assert jobs.due(st, fri) == ["evening", "weekly"]
    jobs.mark_done(st, "evening", fri)
    assert jobs.due(st, fri) == ["weekly"]
    assert jobs.due(st, datetime(2026, 11, 6, 21, 0, tzinfo=TZ)) == []   # window passed
    assert "weekly" not in jobs.due(st, datetime(2026, 11, 5, 18, 5, tzinfo=TZ))


class CountingStorage(SqliteStorage):
    def __init__(self):
        super().__init__(":memory:")
        self.writes = []

    def put(self, kind, id, data):
        self.writes.append((kind, id))
        super().put(kind, id, data)


def test_idle_sync_writes_almost_nothing():
    st = CountingStorage()
    fn = FakeNotion()
    seed(fn)
    Syncer(fn, st, lambda: NOW).run()
    st.writes.clear()
    Syncer(fn, st, lambda: NOW).run()
    assert st.writes == [("kv", "last_sync")]


def test_push_only_sends_bot_changes(env):
    st, fn, ids, app = env
    team(app)
    app.on_callback(SERGEY, SERGEY.id, f"t:dd:{ids['t_fabric']}:2")
    s = Syncer(fn, st, lambda: NOW)
    assert s.has_local_changes()
    calls = len(fn.calls)
    s.push()
    assert [c[0] for c in fn.calls[calls:]] == ["update"]                # no queries, one page update
    assert not Syncer(fn, st, lambda: NOW).has_local_changes()


def test_sync_command_runs_sync(env):
    st, fn, ids, app = env
    team(app)
    app.sync_fn = lambda: Syncer(fn, st, lambda: NOW).run().short()
    r = app.on_command(SERGEY, SERGEY.id, True, "sync")
    assert "Синхронизировано" in r.screen.text and "Задач: 5" in r.screen.text
