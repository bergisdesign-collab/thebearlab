import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { App } from "../src/app.ts";
import type { Screen, Who } from "../src/app.ts";
import * as jobs from "../src/jobs.ts";
import * as logic from "../src/logic.ts";
import { newMilestone, newTask } from "../src/models.ts";
import type { Storage } from "../src/storage.ts";
import { Syncer } from "../src/sync.ts";
import { FakeNotion, NOW, P, at, newStore, seed } from "./fakes.ts";
import type { SqliteD1 } from "./fakes.ts";

const SERGEY: Who = { id: 1001, name: "Сергей", username: "sergey" };
const ANYA: Who = { id: 1002, name: "Аня", username: "anya" };
const GROUP = -100500;
const clock = () => NOW;

let st: Storage, d1: SqliteD1, fn: FakeNotion, ids: Record<string, string>, app: App;

const sync = (c = clock) => new Syncer(fn, st, c, 1000).run();
const buttons = (s?: Screen) => (s ? s.kb.flat() : []);

async function team(): Promise<void> {
  await app.start(SERGEY);
  const r = await app.start(ANYA);
  assert.match(r.screen!.text, /Заявка отправлена/);
  assert.equal(r.notices[0].chatId, SERGEY.id);
  await app.onCallback(SERGEY, SERGEY.id, `m:ok:${ANYA.id}`);
  await app.onCommand(SERGEY, GROUP, false, "bindchat");
}

beforeEach(async () => {
  ({ st, d1 } = await newStore());
  fn = new FakeNotion();
  ids = seed(fn);
  await sync();
  st.refresh();
  app = new App(st, clock);
});

describe("logic", () => {
  it("progress and bar", () => {
    const ts = [newTask({ id: "a", title: "a", status: "Готово" }), newTask({ id: "b", title: "b" })];
    assert.deepEqual(logic.progress(ts), [1, 2, 50]);
    assert.equal(logic.bar(50, 10), "▰".repeat(5) + "▱".repeat(5));
  });

  it("streak counts clean days and skips holidays", () => {
    const days: Record<string, logic.DayRec> = {};
    for (const d of ["2026-12-29", "2026-12-30", "2026-12-31", "2027-01-12", "2027-01-13"]) days[d] = { overdue: 0, done: 0, by_member: {} };
    assert.equal(logic.streak(days, "2027-01-13"), 5);
    days["2026-12-30"].overdue = 2;
    assert.equal(logic.streak(days, "2027-01-13"), 3);
    assert.equal(logic.streak({}, "2027-01-13"), 0);
  });

  it("deadline never on holidays", () => {
    assert.equal(logic.skipHolidays("2027-01-05"), "2027-01-12");
    assert.equal(logic.skipHolidays("2026-12-30"), "2026-12-30");
  });

  it("parses dates", () => {
    const t = "2026-11-05";
    assert.equal(logic.parseDate("15.11", t), "2026-11-15");
    assert.equal(logic.parseDate("10.01", t), "2027-01-10");
    assert.equal(logic.parseDate("+3", t), "2026-11-08");
    assert.equal(logic.parseDate("завтра", t), "2026-11-06");
    assert.equal(logic.parseDate("2026-12-01", t), "2026-12-01");
    assert.equal(logic.parseDate("ерунда", t), null);
    assert.equal(logic.parseDate("31.02", t), null);
  });

  it("mentor respects dependencies and explains", async () => {
    const sug = logic.suggest(await st.tasks(), await st.milestones(), null, "2026-11-05", 10);
    const titles = sug.map((s) => s.task.title);
    assert.ok(!titles.includes("Утвердить гейм-диздок"));
    assert.ok(!titles.includes("Написать гейм-диздок"));
    assert.equal(sug[0].task.title, "Решить, успеваем ли к Новому году");
    assert.ok(sug[0].reasons.some((r) => r.includes("веха")) && sug[0].reasons.includes("нужно принять решение"));
  });

  it("search stems Russian", () => {
    const hits = logic.search("ткань", [newTask({ id: "a", title: "Найти поставщика ткани" })], []);
    assert.equal(hits[0].obj.id, "a");
  });

  it("milestone status", () => {
    const m = newMilestone({ id: "m", title: "M", date: "2026-11-10" });
    const late = newTask({ id: "a", title: "a", due: "2026-11-01", milestones: ["m"] });
    const ok = newTask({ id: "b", title: "b", status: "Готово", milestones: ["m"] });
    assert.equal(logic.milestoneStatus(m, [late, ok], "2026-11-05"), "Под угрозой");
    late.status = "Готово";
    assert.equal(logic.milestoneStatus(m, [late, ok], "2026-11-05"), "Достигнута");
  });
});

describe("access", () => {
  it("first user is admin, others need approval", async () => {
    const r = await app.start(SERGEY);
    assert.match(r.screen!.text, /администратор/);
    await app.start(ANYA);
    assert.match((await app.onCommand(ANYA, ANYA.id, true, "my")).screen!.text, /\/start/);
    assert.ok((await app.onCallback(ANYA, ANYA.id, `m:ok:${ANYA.id}`)).alert);
    const ok = await app.onCallback(SERGEY, SERGEY.id, `m:ok:${ANYA.id}`);
    assert.equal(ok.notices[0].chatId, ANYA.id);
    assert.ok((await st.member(ANYA.id))!.approved);
  });

  it("ADMIN_IDS make a later user admin", async () => {
    await app.start(SERGEY);
    const a2 = new App(st, clock, { adminIds: new Set([String(ANYA.id)]) });
    await a2.start(ANYA);
    assert.ok((await st.member(ANYA.id))!.admin);
  });

  it("ADMIN_IDS accept @usernames", async () => {
    const { adminIds } = await import("../src/config.ts");
    const admins = adminIds({ ADMIN_IDS: "111; @Anya ,@Sergey" });
    assert.deepEqual([...admins], ["111", "anya", "sergey"]);
    await app.start({ id: 5, name: "Первый" });
    await new App(st, clock, { adminIds: admins }).start(ANYA);
    assert.ok((await st.member(ANYA.id))!.admin);
  });
});

describe("tasks", () => {
  it("take, release, history and broadcast", async () => {
    await team();
    const tid = ids.t_fabric;
    let r = await app.onCallback(ANYA, ANYA.id, `t:take:${tid}`);
    let t = (await st.task(tid))!;
    assert.equal(t.assignee_tg, ANYA.id);
    assert.equal(t.status, "В работе");
    for (const f of ["assignee_notion", "status", "log"]) assert.ok(t.dirty.includes(f));
    assert.match(t.log, /Аня: взята в работу/);
    assert.ok(r.notices.some((n) => n.chatId === GROUP && n.text.includes("Аня")));

    r = await app.onCallback(SERGEY, SERGEY.id, `t:take:${tid}`);
    assert.ok(r.alert && r.toast!.includes("Аня"));

    r = await app.onCallback(SERGEY, SERGEY.id, `t:to:${tid}:${SERGEY.id}`);
    assert.equal((await st.task(tid))!.assignee_tg, SERGEY.id);
    assert.ok(r.notices.some((n) => n.chatId === ANYA.id));

    r = await app.onCallback(SERGEY, SERGEY.id, `t:log:${tid}`);
    assert.match(r.screen!.text, /взята в работу/);
    assert.match(r.screen!.text, /назначена на Сергей/);
  });

  it("result moves to review, then done", async () => {
    await team();
    const tid = ids.t_decide;
    await app.onCallback(SERGEY, SERGEY.id, `t:res:${tid}`);
    await app.onText(SERGEY, SERGEY.id, true, "https://docs.example/decision");
    let t = (await st.task(tid))!;
    assert.equal(t.result, "https://docs.example/decision");
    assert.equal(t.status, "На проверке");
    const r = await app.onCallback(ANYA, ANYA.id, `t:st:${tid}:3`);
    assert.equal((await st.task(tid))!.status, "Готово");
    assert.ok(r.notices.some((n) => n.chatId === GROUP && n.text.includes("✅")));
    const evs = await st.events("", tid);
    assert.equal(evs[evs.length - 1].kind, "done");
  });

  it("postpone and custom date", async () => {
    await team();
    const tid = ids.t_fabric;
    await app.onCallback(SERGEY, SERGEY.id, `t:dd:${tid}:3`);
    assert.equal((await st.task(tid))!.due, "2026-12-03");
    await app.onCallback(SERGEY, SERGEY.id, `t:date:${tid}`);
    await app.onText(SERGEY, SERGEY.id, true, "05.01");
    assert.equal((await st.task(tid))!.due, "2027-01-12");
    await app.onCallback(SERGEY, SERGEY.id, `t:date:${tid}`);
    await app.onText(SERGEY, SERGEY.id, true, "нет");
    assert.equal((await st.task(tid))!.due, null);
  });

  it("new task wizard", async () => {
    await team();
    await app.onCommand(SERGEY, SERGEY.id, true, "new");
    await app.onText(SERGEY, SERGEY.id, true, "Сделать прайс-лист");
    await app.onCallback(SERGEY, SERGEY.id, "n:st:2");
    await app.onCallback(SERGEY, SERGEY.id, "n:pr:Высокий");
    const r = await app.onCallback(SERGEY, SERGEY.id, "n:due:7");
    assert.ok(r.newMessage && r.screen!.text.includes("Сделать прайс-лист"));
    const t = (await st.tasks()).find((x) => x.title === "Сделать прайс-лист")!;
    assert.ok(t.id.startsWith("local-"));
    assert.equal(t.stage, "3. Маркетинг");
    assert.equal(t.priority, "Высокий");
    assert.equal(t.due, "2026-11-12");
    assert.equal(await st.kvGet(`await:${SERGEY.id}`), null);
  });

  it("free text is search; commands cancel input; group chatter ignored", async () => {
    await team();
    let r = await app.onText(ANYA, ANYA.id, true, "ткань");
    assert.ok(buttons(r!.screen).some((b) => b.data === `t:v:${ids.t_fabric}`));
    await app.onCallback(ANYA, ANYA.id, `t:note:${ids.t_fabric}`);
    await app.onCommand(ANYA, ANYA.id, true, "my");
    r = await app.onText(ANYA, ANYA.id, true, "паспорт");
    assert.ok(buttons(r!.screen).some((b) => (b.data || "").startsWith("i:v:")));
    assert.equal(await app.onText(ANYA, GROUP, false, "привет"), null);
  });

  it("every screen renders with valid buttons", async () => {
    await team();
    const seen = new Set<string>();
    const queue = ["go:menu"];
    for (const cmd of ["today", "my", "next", "free", "tasks", "plan", "milestones", "ideas", "team", "help", "sync"]) {
      const r = await app.onCommand(SERGEY, SERGEY.id, true, cmd);
      assert.ok(r.screen && r.screen.text.length < 4096, cmd);
      queue.push(...buttons(r.screen).filter((b) => b.data).map((b) => b.data!));
    }
    const mutating = new Set(["take", "rel", "to", "st", "dd", "ok", "no", "ps", "rej", "ln"]);
    while (queue.length) {
      const data = queue.pop()!;
      if (seen.has(data) || mutating.has(data.split(":")[1])) continue;
      seen.add(data);
      const r = await app.onCallback(SERGEY, SERGEY.id, data);
      assert.ok(!(r.toast || "").includes("устарела"), data);
      if (r.screen) {
        assert.ok(r.screen.text.length < 4096);
        for (const b of buttons(r.screen)) {
          assert.ok(b.url || (b.data && new TextEncoder().encode(b.data).length <= 64), JSON.stringify(b));
          if (b.data) queue.push(b.data);
        }
      }
    }
    assert.ok(seen.size > 20, String(seen.size));
  });
});

describe("ideas & team", () => {
  it("idea becomes a task and the relation reaches Notion", async () => {
    await team();
    await app.onCallback(SERGEY, SERGEY.id, `i:ps:${ids.idea}:5`);
    let t = (await st.tasks()).find((x) => x.title === "Паспорт мишки")!;
    assert.match(t.description, /Что закрывает/);
    assert.equal(t.stage, "6. Приложение");
    await sync();
    st.refresh();
    t = (await st.task(t.id))!;
    assert.ok(t.notion_id && !t.dirty.length);
    const page = fn.page(ids.idea);
    assert.equal(page.properties["Статус"].status.name, "В задачах");
    assert.deepEqual(page.properties["Задача"].relation.map((r: any) => r.id.replace(/-/g, "")), [t.notion_id]);
    assert.equal((await st.idea(ids.idea))!.dirty.length, 0);
  });

  it("link member to Notion user", async () => {
    await team();
    const r = await app.onCallback(ANYA, ANYA.id, `m:link:${ANYA.id}`);
    assert.ok(buttons(r.screen).every((b) => !b.text.includes("Integration")));
    await app.onCallback(ANYA, ANYA.id, `m:ln:${ANYA.id}:aaaaaaaa000000000000000000000002`);
    assert.equal((await st.task(ids.t_gdd))!.assignee_tg, ANYA.id);
    assert.match((await app.onCommand(ANYA, ANYA.id, true, "my")).screen!.text, /Мои задачи \(1\)/);
  });
});

describe("sync", () => {
  it("initial pull", async () => {
    assert.equal((await st.tasks()).length, 5);
    assert.equal((await st.milestones()).length, 2);
    assert.equal((await st.ideas()).length, 1);
    const t = (await st.task(ids.t_after))!;
    assert.deepEqual(t.depends_on, [ids.t_gdd]);
    assert.equal(t.due, "2026-11-20");
    assert.ok(await st.kvGet("last_sync"));
  });

  it("bot change pushed, Notion change pulled", async () => {
    await team();
    await app.onCallback(SERGEY, SERGEY.id, `t:dd:${ids.t_fabric}:1`);
    fn.edit(ids.t_fabric, "Описание", P("rich_text", "Новое описание из Notion"));
    await sync();
    st.refresh();
    const t = (await st.task(ids.t_fabric))!;
    assert.equal(t.description, "Новое описание из Notion");
    assert.equal(fn.page(ids.t_fabric).properties["Срок"].date.start, "2026-12-01");
    assert.equal(t.dirty.length, 0);
    assert.match(fn.page(ids.t_fabric).properties["Журнал"].rich_text[0].plain_text, /срок/);
  });

  it("conflict: the bot's dirty field wins", async () => {
    await team();
    await app.onCallback(SERGEY, SERGEY.id, `t:st:${ids.t_fabric}:1`);
    fn.edit(ids.t_fabric, "Статус", P("status", "На проверке"));
    await sync();
    st.refresh();
    assert.equal((await st.task(ids.t_fabric))!.status, "В работе");
    assert.equal(fn.page(ids.t_fabric).properties["Статус"].status.name, "В работе");
  });

  it("local task is created in Notion once", async () => {
    await team();
    await app.onCommand(SERGEY, SERGEY.id, true, "new", "Купить образцы");
    await app.onCallback(SERGEY, SERGEY.id, "n:st:3");
    await app.onCallback(SERGEY, SERGEY.id, "n:pr:Средний");
    await app.onCallback(SERGEY, SERGEY.id, "n:due:0");
    await sync();
    await sync();
    st.refresh();
    assert.equal(fn.log.filter((c) => c[0] === "create").length, 1);
    assert.equal((await st.tasks()).filter((t) => t.title === "Купить образцы").length, 1);
  });

  it("deleted page is archived", async () => {
    fn.dbs[Object.keys(fn.dbs)[0]].delete(ids.t_fabric);
    await sync();
    st.refresh();
    assert.ok((await st.task(ids.t_fabric))!.archived);
    assert.ok(!(await st.tasks()).some((t) => t.id === ids.t_fabric));
  });

  it("assignee from an unlinked member survives sync", async () => {
    await team();
    await app.onCallback(ANYA, ANYA.id, `t:take:${ids.t_fabric}`);
    await sync();
    await sync();
    st.refresh();
    assert.equal((await st.task(ids.t_fabric))!.assignee_tg, ANYA.id);
  });

  it("milestone status is pushed", async () => {
    await sync(at("2026-11-09T06:00:00Z"));
    assert.equal(fn.page(ids.ms_ny).properties["Статус"].status.name, "Под угрозой");
  });

  it("idle sync writes almost nothing", async () => {
    d1.writes = [];
    await sync();
    assert.deepEqual(d1.writes.map((w) => w.split(":").slice(1, 3).join(":")), ["kv:last_sync"]);
  });

  it("push only sends the bot's changes", async () => {
    await team();
    await app.onCallback(SERGEY, SERGEY.id, `t:dd:${ids.t_fabric}:2`);
    const s = new Syncer(fn, st, clock, 1000);
    assert.ok(await s.hasLocalChanges());
    const n = fn.log.length;
    await s.push();
    assert.deepEqual(fn.log.slice(n).map((c) => c[0]), ["update"]);
    st.refresh();
    assert.ok(!(await new Syncer(fn, st, clock).hasLocalChanges()));
  });

  it("push respects the subrequest budget and defers the rest", async () => {
    await team();
    for (const k of ["t_fabric", "t_decide", "t_after"]) await app.onCallback(SERGEY, SERGEY.id, `t:dd:${ids[k]}:1`);
    const s = new Syncer(fn, st, clock, fn.calls + 2);
    const rep = await s.push();
    assert.equal(rep.pushed, 2);
    assert.equal(rep.deferred, 1);
  });

  it("/sync runs a sync", async () => {
    await team();
    app.syncFn = async () => "Задач: 5";
    const r = await app.onCommand(SERGEY, SERGEY.id, true, "sync");
    assert.match(r.screen!.text, /Синхронизировано/);
  });
});

describe("jobs", () => {
  it("morning digest", async () => {
    await team();
    await app.onCallback(ANYA, ANYA.id, `t:take:${ids.t_decide}`);
    const out = await jobs.run("morning", st, clock);
    const group = out.filter((n) => n.chatId === GROUP);
    assert.ok(group.length && group[0].text.includes("Просрочено") && group[0].text.includes("Написать гейм-диздок"));
    assert.match(group[0].text, /До запуска продаж/);
    assert.match(out.find((n) => n.chatId === ANYA.id)!.text, /Решить, успеваем/);
  });

  it("evening only when needed; weekly counts closed tasks", async () => {
    await team();
    const ev = await jobs.run("evening", st, clock);
    assert.ok(!ev.some((n) => n.chatId === SERGEY.id || n.chatId === ANYA.id));
    await app.onCallback(ANYA, ANYA.id, `t:st:${ids.t_decide}:3`);
    const w = await jobs.run("weekly", st, clock);
    assert.match(w[0].text, /Закрыто за неделю: 1/);
  });

  it("no jobs on holidays", async () => {
    await team();
    assert.deepEqual(await jobs.run("morning", st, at("2027-01-03T06:00:00Z")), []);
  });

  it("due once per day", async () => {
    assert.deepEqual(await jobs.due(st, new Date("2026-11-06T05:55:00Z")), []);
    assert.deepEqual(await jobs.due(st, new Date("2026-11-06T06:03:00Z")), ["morning"]);
    const fri = new Date("2026-11-06T15:05:00Z");
    assert.deepEqual(await jobs.due(st, fri), ["evening", "weekly"]);
    await jobs.markDone(st, "evening", fri);
    assert.deepEqual(await jobs.due(st, fri), ["weekly"]);
    assert.deepEqual(await jobs.due(st, new Date("2026-11-06T18:00:00Z")), []);
    assert.ok(!(await jobs.due(st, new Date("2026-11-05T15:05:00Z"))).includes("weekly"));
  });
});
