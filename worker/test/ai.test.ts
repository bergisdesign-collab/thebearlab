// AI layer with a scripted fake model: tools change tasks through the same rules as buttons.
import assert from "node:assert/strict";
import { beforeEach, it } from "node:test";
import { Assistant, TOOLS } from "../src/ai.ts";
import type { LlmApi } from "../src/ai.ts";
import { App } from "../src/app.ts";
import type { Who } from "../src/app.ts";
import type { Env } from "../src/config.ts";
import { handleFetch } from "../src/index.ts";
import * as jobs from "../src/jobs.ts";
import { shortId } from "../src/models.ts";
import type { Storage } from "../src/storage.ts";
import { Syncer } from "../src/sync.ts";
import { FakeNotion, FakeTelegram, NOW, SqliteD1, newStore, seed } from "./fakes.ts";

const SERGEY: Who = { id: 1001, name: "Сергей", username: "sergey" };
const ANYA: Who = { id: 1002, name: "Аня", username: "anya" };
const GROUP = -100500;
const clock = () => NOW;

/** Replays a script: each step is the model's reply; records every request. */
class FakeLlm implements LlmApi {
  calls = 0;
  requests: any[] = [];
  script: ((req: any) => any)[];
  constructor(script: ((req: any) => any)[]) { this.script = script; }
  async messages(body: any): Promise<any> {
    this.requests.push(structuredClone(body));
    const step = this.script[this.calls++];
    if (!step) throw new Error("script exhausted");
    return step(body);
  }
}

const tool = (name: string, input: any, id = "tu1") => () => ({ stop_reason: "tool_use", content: [{ type: "text", text: "Сейчас сделаю." }, { type: "tool_use", id, name, input }] });
const say = (text: string) => () => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });

let st: Storage, fn: FakeNotion, ids: Record<string, string>, app: App;

beforeEach(async () => {
  ({ st } = await newStore());
  fn = new FakeNotion();
  ids = seed(fn);
  await new Syncer(fn, st, clock, 1000).run();
  st.refresh();
  app = new App(st, clock);
  await app.start(SERGEY);
  await app.start(ANYA);
  await app.onCallback(SERGEY, SERGEY.id, `m:ok:${ANYA.id}`);
  await app.onCommand(SERGEY, GROUP, false, "bindchat");
});

it("tool schemas are valid", () => {
  for (const [name, t] of Object.entries(TOOLS)) {
    assert.match(name, /^[a-z_]+$/);
    assert.equal(t.input_schema.type, "object");
    for (const r of t.input_schema.required) assert.ok(r in t.input_schema.properties, `${name}.${r}`);
  }
});

it("«перенеси ткань на пятницу и отдай Ане» changes the task, notifies, remembers the dialogue", async () => {
  const sergey = (await st.member(SERGEY.id))!;
  const llm = new FakeLlm([
    tool("set_due", { task: "ткань", date: "2026-11-13" }),
    tool("assign_task", { task: shortId(ids.t_fabric), member: "Аня" }, "tu2"),
    say("Готово: «Найти поставщика ткани» — срок 13.11, исполнитель Аня."),
  ]);
  const r = await new Assistant(app, llm, clock).ask(sergey, "перенеси ткань на пятницу и отдай Ане");
  const t = (await st.task(ids.t_fabric))!;
  assert.equal(t.due, "2026-11-13");
  assert.equal(t.assignee_tg, ANYA.id);
  assert.ok(t.dirty.includes("due") && t.dirty.includes("assignee_notion"));          // goes to Notion
  assert.match(t.log, /срок: 30\.11 → 13\.11/);
  assert.match(r.screen!.text, /Готово/);
  assert.ok(r.screen!.kb.flat().some((b) => b.data === `t:v:${ids.t_fabric}`));
  assert.ok(r.notices.some((n) => n.chatId === GROUP));                               // team sees it
  assert.ok(r.notices.some((n) => n.chatId === ANYA.id));                             // Аня gets a DM

  // context: system prompt is cached, live roadmap and the task code are in it
  const req = llm.requests[0];
  assert.equal(req.model, "claude-haiku-5-5");
  assert.deepEqual(req.system[0].cache_control, { type: "ephemeral" });
  assert.match(req.system[1].text, /Найти поставщика ткани/);
  assert.match(req.system[1].text, new RegExp(shortId(ids.t_fabric)));
  // the tool result went back to the model
  assert.equal(llm.requests[1].messages.at(-1).content[0].type, "tool_result");

  // next question sees the previous turn
  const llm2 = new FakeLlm([say("Ок")]);
  await new Assistant(app, llm2, clock).ask(sergey, "спасибо");
  const msgs = llm2.requests[0].messages;
  assert.equal(msgs[0].content, "перенеси ткань на пятницу и отдай Ане");
  assert.equal(msgs.at(-1).content, "спасибо");
});

it("ambiguous task: the model gets the candidates instead of a random change", async () => {
  const sergey = (await st.member(SERGEY.id))!;
  const llm = new FakeLlm([tool("set_status", { task: "гейм-диздок", status: "Готово" }), say("Какую именно?")]);
  await new Assistant(app, llm, clock).ask(sergey, "закрой гейм-диздок");
  const res = llm.requests[1].messages.at(-1).content[0];
  assert.equal(res.is_error, true);
  assert.match(res.content, /несколько задач/);
  assert.equal((await st.task(ids.t_gdd))!.status, "Не начато");
});

it("permissions apply: a partner cannot release someone else's task through the AI", async () => {
  const anya = (await st.member(ANYA.id))!;
  await app.onCallback(SERGEY, SERGEY.id, `t:take:${ids.t_fabric}`);
  const llm = new FakeLlm([tool("assign_task", { task: "ткань", member: "nobody" }), say("Не могу.")]);
  await new Assistant(app, llm, clock).ask(anya, "освободи ткань");
  assert.equal(llm.requests[1].messages.at(-1).content[0].is_error, true);
  assert.equal((await st.task(ids.t_fabric))!.assignee_tg, SERGEY.id);
});

it("team memory: remember shows up in the next context", async () => {
  const sergey = (await st.member(SERGEY.id))!;
  await new Assistant(app, new FakeLlm([tool("remember", { fact: "Шьём из минки, не из плюша" }), say("Запомнил.")]), clock).ask(sergey, "решили шить из минки");
  const llm = new FakeLlm([say("Из минки.")]);
  await new Assistant(app, llm, clock).ask(sergey, "из чего шьём?");
  assert.match(llm.requests[0].system[1].text, /Шьём из минки/);
});

it("create, read-only tools, overview", async () => {
  const sergey = (await st.member(SERGEY.id))!;
  const a = new Assistant(app, new FakeLlm([]), clock);
  const created: any = await a.runTool(sergey, "create_task", { title: "Заказать образцы минки", stage: "4. Производство", priority: "Высокий", due: "2026-11-20" });
  assert.equal(created.task.title, "Заказать образцы минки");
  const found: any = await a.runTool(sergey, "find_tasks", { assignee: "free", stage: "4. Производство" });
  assert.ok(found.tasks.some((t: any) => t.title === "Заказать образцы минки"));
  const ov: any = await a.runTool(sergey, "roadmap_overview", {});
  assert.ok(ov.overdue.some((t: any) => t.title === "Написать гейм-диздок"));
  const next: any = await a.runTool(sergey, "suggest_next", {});
  assert.ok(next.length && next[0].reasons.length);
  const idea: any = await a.runTool(sergey, "promote_idea", { idea: "паспорт", stage: "6. Приложение" });
  assert.equal(idea.task.title, "Паспорт мишки");
});

it("free text in private chat goes to the AI when connected; /ask works in groups", async () => {
  const llm = new FakeLlm([say("Горит гейм-диздок."), say("И в группе отвечаю.")]);
  app.askFn = (m, text) => new Assistant(app, llm, clock).ask(m, text);
  const r = await app.onText(SERGEY, SERGEY.id, true, "что горит?");
  assert.match(r!.screen!.text, /Горит/);
  const g = await app.onCommand(SERGEY, GROUP, false, "ask", "а в группе?");
  assert.match(g.screen!.text, /в группе/);
});

it("weekly review by Opus is added to the Friday report", async () => {
  const llm = new FakeLlm([say("1) Продвинулись: решение по НГ.\n2) Застряли: гейм-диздок.")]);
  const out = await jobs.run("weekly", st, clock, { weeklyReview: () => new Assistant(app, llm, clock).weeklyReview() });
  assert.equal(llm.requests[0].model, "claude-opus-5-5");
  assert.ok(out.some((n) => n.text.includes("Разбор недели") && n.text.includes("гейм-диздок")));
});

it("voice message → OpenAI transcription → AI answer, end to end through the Worker", async () => {
  const d1 = new SqliteD1();
  const tg = new FakeTelegram();
  const env: Env = { DB: d1, BOT_TOKEN: "123:T", WEBHOOK_SECRET: "s", CRON_SECRET: "c", ADMIN_IDS: "1", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" };
  const llm = new FakeLlm([say("Сегодня срок у решения по Новому году.")]);
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]));
    if (url.endsWith("/getFile")) { tg.sent.push({ method: "getFile", body: {} }); return Response.json({ ok: true, result: { file_path: "voice/1.oga" } }); }
    if (url.includes("api.openai.com")) {
      assert.ok(init!.body instanceof FormData);
      assert.equal((init!.body as FormData).get("model"), "gpt-4o-mini-transcribe");
      return Response.json({ text: "что у нас сегодня по срокам" });
    }
    return tg.fetch(url, init);
  };
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
  const deps = { clock, fetchFn, notion: new FakeNotion(), llm };
  const post = async (path: string, body: unknown, headers: Record<string, string>) => {
    const r = await handleFetch(new Request("https://x.workers.dev" + path, { method: "POST", body: JSON.stringify(body), headers }), env, ctx, deps);
    await Promise.all(waits.splice(0));
    return r;
  };
  await post("/setup", {}, { "X-Cron-Secret": "c" });
  const from = { id: 1, is_bot: false, first_name: "Сергей" };
  await post("/tg", { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 1, type: "private" }, from, text: "/start" } }, { "X-Telegram-Bot-Api-Secret-Token": "s" });
  tg.sent = [];
  await post("/tg", { update_id: 2, message: { message_id: 2, date: 0, chat: { id: 1, type: "private" }, from, voice: { file_id: "F1", duration: 3 } } }, { "X-Telegram-Bot-Api-Secret-Token": "s" });
  assert.deepEqual(tg.methods(), ["sendChatAction", "getFile", "sendMessage"]);
  const reply = tg.sent.at(-1)!.body.text;
  assert.match(reply, /🎙 <i>что у нас сегодня по срокам<\/i>/);
  assert.match(reply, /Сегодня срок/);
  assert.equal(llm.requests[0].messages.at(-1).content, "что у нас сегодня по срокам");
});

it("voice uses Cloudflare Workers AI by default (no OpenAI key needed)", async () => {
  const d1 = new SqliteD1();
  const tg = new FakeTelegram();
  const seen: any[] = [];
  const AI = { run: async (model: string, input: any) => { seen.push([model, input]); return { text: "покажи мои задачи" }; } };
  const env: Env = { DB: d1, BOT_TOKEN: "123:T", WEBHOOK_SECRET: "s", CRON_SECRET: "c", ADMIN_IDS: "1", AI };
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("/file/bot")) return new Response(new Uint8Array([104, 105]));
    if (url.endsWith("/getFile")) return Response.json({ ok: true, result: { file_path: "v.oga" } });
    if (url.includes("openai")) throw new Error("must not call OpenAI");
    return tg.fetch(url, init);
  };
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
  const deps = { clock, fetchFn, notion: null, llm: null };
  const post = async (path: string, body: unknown, headers: Record<string, string>) => {
    await handleFetch(new Request("https://x.workers.dev" + path, { method: "POST", body: JSON.stringify(body), headers }), env, ctx, deps);
    await Promise.all(waits.splice(0));
  };
  await post("/setup", {}, { "X-Cron-Secret": "c" });
  const from = { id: 1, is_bot: false, first_name: "Сергей" };
  await post("/tg", { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 1, type: "private" }, from, text: "/start" } }, { "X-Telegram-Bot-Api-Secret-Token": "s" });
  await post("/tg", { update_id: 2, message: { message_id: 2, date: 0, chat: { id: 1, type: "private" }, from, voice: { file_id: "F" } } }, { "X-Telegram-Bot-Api-Secret-Token": "s" });
  assert.equal(seen[0][0], "@cf/openai/whisper-large-v3-turbo");
  assert.equal(seen[0][1].audio, btoa("hi"));
  assert.match(tg.sent.at(-1)!.body.text, /🎙 <i>покажи мои задачи<\/i>/);   // without AI key: transcribed, then searched
});
