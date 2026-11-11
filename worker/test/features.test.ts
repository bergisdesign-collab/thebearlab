// Bot API 10.x features and team memory, end to end through the Worker entry.
import assert from "node:assert/strict";
import { it } from "node:test";
import { inflateSync, deflateSync } from "node:zlib";
import type { LlmApi } from "../src/ai.ts";
import { BOARD_HTML } from "../src/board.ts";
import { NOTION_MEMORY_DB } from "../src/config.ts";
import type { Env } from "../src/config.ts";
import { handleFetch, runtime } from "../src/index.ts";
import { memories } from "../src/memory.ts";
import { shortId } from "../src/models.ts";
import { Storage } from "../src/storage.ts";
import { FakeNotion, FakeTelegram, NOW, P, SqliteD1, seed } from "./fakes.ts";

class FakeLlm implements LlmApi {
  calls = 0;
  requests: any[] = [];
  replies: any[];
  constructor(replies: any[]) { this.replies = replies; }
  async messages(body: any): Promise<any> {
    this.requests.push(body);
    const r = this.replies[this.calls++];
    if (!r) throw new Error("script exhausted");
    return typeof r === "function" ? r(body) : r;
  }
}
const say = (text: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });
const tool = (name: string, input: any) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name, input }] });

const ME = { id: 1, is_bot: false, first_name: "Сергей", username: "sergey" };
const ANYA = { id: 2, is_bot: false, first_name: "Аня", username: "anya" };
const GROUP = -100;

async function world(llm: LlmApi | null = null) {
  const d1 = new SqliteD1();
  const env: Env = { DB: d1, BOT_TOKEN: "1:T", WEBHOOK_SECRET: "s", CRON_SECRET: "c", NOTION_TOKEN: "n", ADMIN_IDS: "1" };
  const fn = new FakeNotion();
  const ids = seed(fn);
  const tg = new FakeTelegram();
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
  const deps = { clock: () => NOW, fetchFn: tg.fetch, notion: fn, llm };
  const post = async (path: string, body: unknown) => {
    const headers = path === "/tg" ? { "X-Telegram-Bot-Api-Secret-Token": "s" } : { "X-Cron-Secret": "c" };
    const r = await handleFetch(new Request("https://x.workers.dev" + path, { method: "POST", body: JSON.stringify(body), headers }), env, ctx, deps);
    await Promise.all(waits.splice(0));
    return r;
  };
  let n = 0;
  const text = (from: any, chat: any, t: string, extra: any = {}) => post("/tg", { update_id: ++n, message: { message_id: 1000 + n, date: 0, chat, from, text: t, ...extra } });
  const press = (from: any, chat: any, data: string, msgExtra: any = {}) => post("/tg", { update_id: ++n, callback_query: { id: "cb" + n, from, chat_instance: "x", data, message: { message_id: 7, date: 0, chat, text: "x", ...msgExtra } } });
  const dm = (from: any) => ({ id: from.id, type: "private" });
  const grp = { id: GROUP, type: "supergroup" };
  await post("/setup", {});
  await post("/tick", {});                                     // first sync from Notion
  await text(ME, dm(ME), "/start");
  await text(ANYA, dm(ANYA), "/start");
  await press(ME, dm(ME), `m:ok:${ANYA.id}`);
  await text(ME, grp, "/bindchat");
  tg.sent = [];
  return { d1, env, fn, ids, tg, post, text, press, dm, grp, st: () => new Storage(d1), deps };
}

it("rich messages: the digest is a rich message with headings and tables", async () => {
  const w = await world();
  await w.text(ME, w.dm(ME), "/today");
  const r = w.tg.sent.find((x) => x.method === "editMessageText" || x.method === "sendRichMessage")!;
  const mdText: string = r.body.rich_message.markdown;
  assert.match(mdText, /^### TheBearLab · Сводка/);
  assert.match(mdText, /\| Задача \| Срок \| Кто \|/);
  assert.match(mdText, /Написать гейм-диздок/);
  assert.ok(r.body.reply_markup.inline_keyboard.length);
});

it("ephemeral: button presses in the group are answered only to the person who pressed", async () => {
  const w = await world();
  await w.press(ANYA, w.grp, "go:my");
  const e = w.tg.sent.find((x) => x.body.ephemeral_message_parameters)!;
  assert.equal(e.body.ephemeral_message_parameters.callback_query_id.startsWith("cb"), true);
  assert.equal(e.body.ephemeral_message_parameters.replace_callback_query_message, true);
  assert.equal(e.body.chat_id, undefined);
  w.tg.sent = [];
  // a press inside that ephemeral message edits it for her
  await w.press(ANYA, w.grp, "go:free", { ephemeral_message_id: 55, receiver_user: ANYA });
  const ed = w.tg.sent.find((x) => x.method === "editEphemeralMessageText")!;
  assert.equal(ed.body.receiver_user_id, ANYA.id);
  assert.equal(ed.body.ephemeral_message_id, 55);
  // an ephemeral command gets an ephemeral answer
  w.tg.sent = [];
  await w.text(ANYA, w.grp, "/my", { ephemeral_message_id: 77 });
  const ec = w.tg.sent.find((x) => x.body.reply_parameters?.ephemeral_message_id)!;
  assert.equal(ec.body.reply_parameters.ephemeral_message_id, 77);
  assert.equal(ec.body.ephemeral_message_parameters.receiver_user_id, ANYA.id);
  // ephemeral commands are declared
  const cmds = (await (async () => { const t2 = new FakeTelegram(); const rt = runtime(w.env, { ...w.deps, fetchFn: t2.fetch }); await rt.tg.setCommands(); return t2.sent[0].body.commands; })());
  assert.equal(cmds.find((c: any) => c.command === "my").is_ephemeral, true);
  assert.equal(cmds.find((c: any) => c.command === "today").is_ephemeral, undefined);
});

it("one window: answers edit the panel; a notice in between opens a fresh panel below", async () => {
  const w = await world();
  await w.text(ME, w.dm(ME), "/plan");
  assert.deepEqual(w.tg.methods(), ["editMessageText", "deleteMessage"]);
  w.tg.sent = [];
  // Аня assigns a task to me → a notice arrives in my chat
  await w.press(ANYA, w.dm(ANYA), `t:to:${w.ids.t_fabric}:${ME.id}`);
  assert.ok(w.tg.sent.some((x) => x.method === "sendMessage" && x.body.chat_id === ME.id));
  w.tg.sent = [];
  await w.text(ME, w.dm(ME), "/my");
  assert.match(w.tg.sent[0].method, /^send(Rich)?Message$/);   // a new panel, not an edit of the old one
  w.tg.sent = [];
  await w.text(ME, w.dm(ME), "/window");
  w.tg.sent = [];
  await w.text(ME, w.dm(ME), "/free");
  assert.ok(!w.tg.methods().includes("deleteMessage"));         // switched off
});

it("live board widget: sent in private, ✓ closes the task, state fits the limits", async () => {
  const w = await world();
  await w.press(ME, w.dm(ME), `t:take:${w.ids.t_fabric}`);
  w.tg.sent = [];
  await w.text(ME, w.dm(ME), "/board");
  const sw = w.tg.sent.find((x) => x.method === "sendWidget")!;
  assert.ok(sw.body.allow_queries);
  assert.ok(new TextEncoder().encode(sw.body.chat_data).length <= 1024);
  const state = JSON.parse(sw.body.chat_data);
  const code = shortId(w.ids.t_fabric);
  assert.ok(state.t.some((t: any) => t[0] === code));
  assert.ok(deflateSync(Buffer.from(BOARD_HTML), { level: 9 }).length < 4096);
  assert.ok(inflateSync(deflateSync(Buffer.from(BOARD_HTML))).length < 32768);
  // in a group: a pointer to the private chat
  w.tg.sent = [];
  await w.text(ME, w.grp, "/board");
  assert.match(w.tg.sent[0].body.text, /в личке/);
  // ✓ from the widget
  w.tg.sent = [];
  await w.post("/tg", { update_id: 999, widget_query: { id: "wq1", from: ME, chat: w.dm(ME), message_id: 50, chat_instance: "x", type: { type: "data" }, data: `d:${code}` } });
  assert.equal((await w.st().task(w.ids.t_fabric))!.status, "Готово");
  const ans = w.tg.sent.find((x) => x.method === "answerWidgetQuery")!;
  assert.ok(!JSON.parse(ans.body.data).t.some((t: any) => t[0] === code));
  assert.ok(w.tg.methods().includes("editMessageWidgetData"));
  assert.ok(w.tg.sent.some((x) => x.method === "sendMessage" && x.body.chat_id === GROUP && /✅/.test(x.body.text)));   // team sees it
  assert.equal(w.fn.page(w.ids.t_fabric).properties["Статус"].status.name, "Готово");                          // and Notion
});

it("memory: the AI saves a conclusion, it goes to Notion «Память команды», edits and deletions come back", async () => {
  const llm = new FakeLlm([tool("remember", { fact: "Шьём из минки, плюш отложили до v2", kind: "Решение" }), say("Записал.")]);
  const w = await world(llm);
  await w.text(ME, w.dm(ME), "решили шить из минки, плюш потом");
  let mem = await memories(w.st());
  assert.equal(mem.length, 1);
  assert.equal(mem[0].kind, "Решение");
  assert.match(w.tg.shown(), /📝 Запомнил: Шьём из минки/);
  // pushed to Notion right after the message
  const pages = [...w.fn.dbs[NOTION_MEMORY_DB].values()];
  assert.equal(pages.length, 1);
  assert.equal(pages[0].properties["Запись"].title[0].plain_text, "Шьём из минки, плюш отложили до v2");
  // edited in Notion → back in the bot
  const pid = pages[0].id.replace(/-/g, "");
  w.fn.edit(pid, "Запись", P("title", "Шьём из минки"));
  await w.post("/tick", {});
  mem = await memories(w.st());
  assert.equal(mem[0].text, "Шьём из минки");
  // the next AI request sees it in the context
  const llm2 = new FakeLlm([say("Из минки.")]);
  const rt = runtime(w.env, { ...w.deps, llm: llm2 });
  await rt.app.askFn!((await rt.st.member(ME.id))!, "из чего шьём?");
  assert.match(llm2.requests[0].system[1].text, /Решение \| Сергей \| Шьём из минки/);
  // /memory → delete → archived in Notion
  w.tg.sent = [];
  await w.press(ME, w.dm(ME), `mem:del:${mem[0].id}:0`);
  assert.equal((await memories(w.st())).length, 0);
  assert.equal(w.fn.dbs[NOTION_MEMORY_DB].size, 0);
  // a record added by hand in Notion appears in the bot
  w.fn.add(NOTION_MEMORY_DB, { "Запись": P("title", "Фабрика берёт заказы от 50 штук"), "Вид": P("select", "Факт"), "Код": P("rich_text", "") });
  await w.post("/tick", {});
  assert.equal((await memories(w.st()))[0].source, "Notion");
});

it("group chat: ordinary messages are buffered briefly, conclusions are extracted and announced, the buffer is deleted", async () => {
  const llm = new FakeLlm([say('[{"kind":"Договорённость","text":"Аня до пятницы присылает три образца ткани"},{"kind":"Решение","text":"Логотип оставляем без изменений"}]')]);
  const w = await world(llm);
  await w.text(ME, w.grp, "по ткани что решили?");
  await w.text(ANYA, w.grp, "я до пятницы пришлю три образца");
  await w.text(ME, w.grp, "ок, и логотип не трогаем");
  assert.equal(((await w.st().get<any>("gbuf", String(GROUP)))?.lines || []).length, 3);
  assert.equal(w.tg.sent.length, 0);                              // the bot stayed silent
  await w.post("/tick", {});
  const mem = await memories(w.st());
  assert.deepEqual(mem.map((m) => m.kind).sort(), ["Договорённость", "Решение"]);
  assert.ok(mem.every((m) => m.source === "Общий чат"));
  assert.ok(w.tg.sent.some((x) => x.body.chat_id === GROUP && /Запомнил из обсуждения/.test(x.body.text)));
  assert.equal(await w.st().get("gbuf", String(GROUP)), null);
  assert.equal(llm.requests[0].model, "claude-haiku-5-5");
  assert.match(llm.requests[0].messages[0].content, /Аня: я до пятницы пришлю три образца/);
});

// ---------------------------------------------------------------- batch: cabinet, settings, reminders, check-in, plan…
import * as jobs from "../src/jobs.ts";
import { AiTimeout, Assistant } from "../src/ai.ts";
import { problems } from "../src/alerts.ts";
import { burndown, chartUrl } from "../src/burndown.ts";
import { NOTION_TASKS_DB } from "../src/config.ts";
import { at } from "./fakes.ts";

const dmTo = (w: any, id: number) => w.tg.sent.filter((x: any) => x.body.chat_id === id);
const said = (xs: any[]) => xs.map((x) => x.body.text ?? x.body.caption ?? x.body.rich_message?.markdown ?? "").join("\n---\n");

it("cabinet: a task I take in the group, or that is assigned to me, lands in my private chat", async () => {
  const w = await world();
  await w.press(ME, w.grp, `t:take:${w.ids.t_fabric}`);
  assert.match(said(dmTo(w, ME.id)), /В твоём кабинете новая задача[\s\S]*Найти поставщика ткани/);
  w.tg.sent = [];
  await w.press(ME, w.dm(ME), `t:to:${w.ids.t_after}:${ANYA.id}`);
  assert.match(said(dmTo(w, ANYA.id)), /В твоём кабинете[\s\S]*Утвердить гейм-диздок[\s\S]*через 15 дн/);
  w.tg.sent = [];
  await w.press(ME, w.dm(ME), `t:take:${w.ids.t_decide}`);   // taking it in my own chat: no extra card
  assert.ok(!/В твоём кабинете/.test(said(dmTo(w, ME.id))));
  await w.text(ME, w.dm(ME), "/my");
  assert.match(w.tg.shown(), /Мой кабинет[\s\S]*Сегодня|Мой кабинет[\s\S]*На неделе|Мой кабинет[\s\S]*Позже/);
});

it("settings: each person switches their own notifications; jobs respect them", async () => {
  const w = await world();
  await w.text(ME, w.dm(ME), "/settings");
  assert.match(w.tg.shown(), /Настройки уведомлений[\s\S]*Общий чат/);    // admin sees group switches too
  await w.press(ANYA, w.dm(ANYA), "pf:morning");
  const st = w.st();
  const out = await jobs.run("morning", st, w.deps.clock);
  assert.ok(!out.some((n) => n.chatId === ANYA.id));
  assert.ok(out.some((n) => n.chatId === GROUP));
  await w.press(ANYA, w.dm(ANYA), "gp:digest");                          // not an admin
  await w.press(ME, w.dm(ME), "gp:digest");
  const out2 = await jobs.run("morning", w.st(), w.deps.clock);
  assert.ok(!out2.some((n) => n.chatId === GROUP));
});

it("deadline tomorrow: the evening reminder warns the assignee a day before", async () => {
  const w = await world();
  await w.press(ME, w.dm(ME), `t:take:${w.ids.t_fabric}`);
  await w.press(ME, w.dm(ME), `t:dd:${w.ids.t_fabric}:-24`);              // move to 06.11 = tomorrow
  const st = w.st();
  const t = (await st.task(w.ids.t_fabric))!;
  if (t.due !== "2026-11-06") { t.due = "2026-11-06"; await st.saveTask(t); }
  const out = await jobs.run("evening", w.st(), at("2026-11-05T15:00:00Z"));
  assert.match(out.find((n) => n.chatId === ME.id)!.text, /Завтра срок[\s\S]*Найти поставщика ткани/);
});

it("reminders: «напомни Ане…» through the AI, delivered by the tick at that time", async () => {
  const llm = new FakeLlm([tool("set_reminder", { member: "Аня", when: "2026-11-05T10:00", text: "Про образцы ткани" }), say("Напомню Ане сегодня в 10:00.")]);
  const w = await world(llm);
  await w.text(ME, w.grp, "Бро, напомни Ане сегодня в 10 про образцы");
  assert.match(said(dmTo(w, ANYA.id)), /поставил\(а\) тебе напоминание на 05\.11 в 10:00/);
  w.tg.sent = [];
  await runtime(w.env, { ...w.deps, clock: at("2026-11-05T06:30:00Z") }).tick();
  assert.ok(!/Напоминание/.test(said(dmTo(w, ANYA.id))));
  await runtime(w.env, { ...w.deps, clock: at("2026-11-05T07:01:00Z") }).tick();
  assert.match(said(dmTo(w, ANYA.id)), /⏰ <b>Напоминание<\/b> от Сергей\nПро образцы ткани/);
  w.tg.sent = [];
  await runtime(w.env, { ...w.deps, clock: at("2026-11-05T07:11:00Z") }).tick();
  assert.ok(!/Напоминание/.test(said(dmTo(w, ANYA.id))));                // only once
});

it("evening check-in: the answer goes into the task journal (no AI)", async () => {
  const w = await world();
  await w.press(ME, w.dm(ME), `t:take:${w.ids.t_fabric}`);
  await w.press(ME, w.dm(ME), `t:st:${w.ids.t_fabric}:1`);
  const out = await jobs.run("checkin", w.st(), at("2026-11-05T16:00:00Z"));
  assert.match(out.find((n) => n.chatId === ME.id)!.text, /что сегодня продвинулось/);
  // the await is stamped with the MSK date; answer the same day (world clock is 05.11)
  w.tg.sent = [];
  await w.text(ME, w.dm(ME), "Списался с двумя фабриками, жду образцы");
  assert.match(w.tg.shown(), /Записал в журнал: «Найти поставщика ткани»/);
  const evs = await w.st().events("", w.ids.t_fabric);
  assert.ok(evs.some((e) => /Чек-ин: Списался/.test(e.text)));
});

it("Notion page text is shown in the task card and given to the AI", async () => {
  const w = await world();
  (w.fn as any).blocks = async () => [
    { type: "heading_2", heading_2: { rich_text: [{ plain_text: "Требования" }] } },
    { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Плюш 300 г/м²" }] } },
    { type: "to_do", to_do: { checked: true, rich_text: [{ plain_text: "Запросить сертификаты" }] } },
  ];
  await w.text(ME, w.dm(ME), "/find ткани");
  await w.press(ME, w.dm(ME), `t:v:${w.ids.t_fabric}`);
  assert.match(w.tg.shown(), /Из страницы Notion[\s\S]*Плюш 300/);
  const cached = await w.st().get<any>("body", w.ids.t_fabric);
  assert.match(cached.text, /☑ Запросить сертификаты/);
});

it("pinned live summary: pinned on /bindchat, edited when the picture changes, not when it doesn't", async () => {
  const w = await world();
  const st = w.st();
  const pin = await st.kvGet<any>("pinned");
  assert.equal(pin.chat, GROUP);
  w.tg.sent = [];
  await w.text(ME, w.dm(ME), "/today");
  assert.ok(!w.tg.sent.some((x) => x.body.chat_id === GROUP && x.body.message_id === pin.id));
  await w.press(ME, w.dm(ME), `t:take:${w.ids.t_fabric}`);
  await w.press(ME, w.dm(ME), `t:st:${w.ids.t_fabric}:3`);                    // done → progress changes
  assert.ok(w.tg.sent.some((x) => x.method === "editMessageText" && x.body.chat_id === GROUP && x.body.message_id === pin.id));
});

it("Monday plan: proposal in the group, «accept all» assigns and sets dates", async () => {
  const w = await world();
  const out = await jobs.run("monday", w.st(), at("2026-11-09T07:00:00Z"));
  const n = out.find((x) => x.chatId === GROUP)!;
  assert.match(n.text, /План недели/);
  assert.ok(n.kb.flat().some((b: any) => b.data === "pl:all"));
  w.tg.sent = [];
  await w.press(ANYA, w.grp, "pl:all");
  const plan = await w.st().kvGet<any>("week_plan");
  assert.ok(plan.items.every((x: any) => x.state === "ok"));
  const t = (await w.st().task(plan.items[0].t))!;
  assert.equal(t.assignee_tg, plan.items[0].who);
  assert.ok(w.tg.sent.some((x) => x.method === "editMessageText" && /План разобран/.test(x.body.text || "")));
});

it("Friday report carries a burndown chart", async () => {
  const w = await world();
  const out = await jobs.run("weekly", w.st(), at("2026-11-06T15:00:00Z"));
  const photo = out.find((x) => x.photo)!;
  assert.match(photo.photo!, /^https:\/\/quickchart\.io\/chart\?/);
  assert.match(photo.text, /Осталось \d+ задач/);
  const b = burndown({ "2026-11-01": { overdue: 0, done: 1, total: 10, by_member: {} } }, "2026-11-06", 8, 7);
  assert.equal(b.actual.at(-1), 8);
  assert.ok(chartUrl(b).length < 8000);
});

it("AI deadline: a slow chain ends with a partial answer instead of silence", async () => {
  let n = 0;
  const llm: LlmApi = { calls: 0, messages: async () => { n++; if (n === 1) return tool("find_tasks", { query: "ткань" }); throw new AiTimeout(); } };
  const w = await world(llm);
  await w.text(ME, w.dm(ME), "найди ткань и всё про неё");
  assert.match(w.tg.shown(), /не успел договорить/);
});

it("dialogue history is kept separately for the private chat and the group", async () => {
  const llm = new FakeLlm([say("Личный ответ"), say("Ответ в чате")]);
  const w = await world(llm);
  await w.text(ME, w.dm(ME), "вопрос в личке");
  await w.text(ME, w.grp, "Бро, вопрос в чате");
  const st = w.st();
  assert.equal((await st.get<any>("chat", String(ME.id))).turns.length, 2);
  assert.equal((await st.get<any>("chat", `${ME.id}:${GROUP}`)).turns.length, 2);
  assert.equal(llm.requests[1].messages.length, 1);                        // the group question did not see the private one
});

it("self-check and alerts: only problems reach admins", async () => {
  assert.deepEqual(problems({ lastSyncMs: NOW.getTime(), syncFails: 0, webhook: { url: "x" }, aiErrors: 0, jobErrors: 0 }, NOW.getTime(), true), []);
  const p = problems({ lastSyncMs: NOW.getTime() - 5 * 3600_000, syncFails: 4, webhook: { url: "", pending_update_count: 50 }, aiErrors: 5, jobErrors: 1 }, NOW.getTime(), true);
  assert.equal(p.length, 6);
  const w = await world();
  const out = await jobs.run("selfcheck", w.st(), w.deps.clock, { health: async () => ["Notion не синхронизировался 5 ч."] });
  assert.deepEqual(out.map((x) => x.chatId), [ME.id]);
  assert.deepEqual(await jobs.run("selfcheck", w.st(), w.deps.clock, { health: async () => [] }), []);
});

it("assigned in Notion → a card in the assignee's private chat", async () => {
  const w = await world();
  const st = w.st();
  const anya = (await st.members()).find((m) => m.tg_id === ANYA.id)!;
  if (!anya.notion_user_id) { anya.notion_user_id = "aaaaaaaa-0000-0000-0000-000000000002"; await st.put("member", String(ANYA.id), anya); }
  w.fn.edit(w.ids.t_fabric, "Исполнитель", { type: "people", people: [{ id: "aaaaaaaa-0000-0000-0000-000000000002" }] });
  w.tg.sent = [];
  await w.post("/tick", {});
  assert.match(said(dmTo(w, ANYA.id)), /Тебя назначили в Notion[\s\S]*Найти поставщика ткани/);
  void NOTION_TASKS_DB;
});
