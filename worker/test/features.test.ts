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
  assert.equal(w.tg.sent[0].method, "sendMessage");             // a new panel, not an edit of the old one
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
