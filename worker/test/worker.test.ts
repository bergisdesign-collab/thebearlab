// End-to-end through the Worker entry: webhook → App → Telegram calls → push to Notion; cron tick; setup.
import assert from "node:assert/strict";
import { it } from "node:test";
import type { Env } from "../src/config.ts";
import { handleFetch, runtime } from "../src/index.ts";
import { Storage } from "../src/storage.ts";
import { FakeNotion, FakeTelegram, NOW, SqliteD1, seed } from "./fakes.ts";

const user = { id: 1, is_bot: false, first_name: "Сергей", username: "sergey" };
const msg = (n: number, text: string) => ({ update_id: n, message: { message_id: n, date: 0, chat: { id: 1, type: "private" }, from: user, text } });
const cb = (n: number, data: string) => ({ update_id: n, callback_query: { id: String(n), from: user, chat_instance: "x", data, message: { message_id: 5, date: 0, chat: { id: 1, type: "private" }, text: "card" } } });

function setup() {
  const d1 = new SqliteD1();
  const env: Env = { DB: d1, BOT_TOKEN: "123:TEST", WEBHOOK_SECRET: "s3cret", CRON_SECRET: "cr0n", NOTION_TOKEN: "x", ADMIN_IDS: "1" };
  const fn = new FakeNotion();
  const ids = seed(fn);
  const tg = new FakeTelegram();
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
  const deps = { clock: () => NOW, fetchFn: tg.fetch, notion: fn };
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await handleFetch(new Request("https://bot.example.workers.dev" + path, { method: "POST", body: JSON.stringify(body), headers }), env, ctx, deps);
    await Promise.all(waits.splice(0));
    return r;
  };
  return { d1, env, fn, ids, tg, call, deps };
}

it("webhook, tick and setup", async () => {
  const { d1, env, fn, ids, tg, call, deps } = setup();
  const H = { "X-Telegram-Bot-Api-Secret-Token": "s3cret" };
  const C = { "X-Cron-Secret": "cr0n" };

  assert.equal((await call("/setup", {})).status, 403);
  const s = await call("/setup", {}, C);
  assert.equal((await s.json()).webhook, "https://bot.example.workers.dev/tg");
  assert.deepEqual(tg.methods(), ["setWebhook", "getMe", "setMyCommands"]);
  assert.equal(tg.sent[0].body.secret_token, "s3cret");

  assert.equal((await call("/tg", msg(1, "/start"), { "X-Telegram-Bot-Api-Secret-Token": "bad" })).status, 403);
  assert.equal((await call("/tick", {})).status, 403);

  const tick = await (await call("/tick", {}, C)).json();
  assert.match(tick.sync, /Задач: 5/);
  assert.equal(tick.morning, 0);                                   // 09:00 MSK, nobody to notify yet
  assert.ok(!("morning" in (await (await call("/tick", {}, C)).json())));   // once a day

  tg.sent = [];
  assert.equal((await call("/tg", msg(2, "/start"), H)).status, 200);
  assert.equal(tg.sent[0].method, "sendMessage");
  assert.match(tg.sent[0].body.text, /администратор/);
  assert.ok(tg.sent[0].body.reply_markup.inline_keyboard.length);

  await call("/tg", msg(3, "/today"), H);
  assert.match(tg.sent[tg.sent.length - 1].body.text, /Сводка/);

  tg.sent = [];
  await call("/tg", cb(4, `t:take:${ids.t_fabric}`), H);
  assert.deepEqual(tg.methods(), ["answerCallbackQuery", "editMessageText"]);
  const st = new Storage(d1);
  const t = (await st.task(ids.t_fabric))!;
  assert.equal(t.assignee_tg, 1);
  assert.equal(t.dirty.length, 0);                                 // pushed to Notion right after the action
  assert.equal(fn.page(ids.t_fabric).properties["Статус"].status.name, "В работе");

  tg.sent = [];
  await call("/tg", msg(5, "ткань"), H);
  assert.match(tg.sent[0].body.text, /Нашёл/);

  // the cron handler path
  const rt = runtime(env, { ...deps, clock: () => new Date("2026-11-05T15:01:00Z") });
  const out = await rt.tick();
  assert.equal(out.evening, 0);
});

it("group /start points to the private chat", async () => {
  const { tg, call } = setup();
  const H = { "X-Telegram-Bot-Api-Secret-Token": "s3cret" };
  await call("/setup", {}, { "X-Cron-Secret": "cr0n" });
  tg.sent = [];
  await call("/tg", { update_id: 1, message: { message_id: 1, date: 0, chat: { id: -5, type: "group" }, from: user, text: "/start@BearLabTaskManager_bot" } }, H);
  assert.match(tg.sent[0].body.text, /в личку/);
});

it("in a group the bot answers @mentions and replies to its messages, and ignores the rest", async () => {
  const { tg, call } = setup();
  const H = { "X-Telegram-Bot-Api-Secret-Token": "s3cret" };
  await call("/setup", {}, { "X-Cron-Secret": "cr0n" });
  await call("/tg", msg(1, "/start"), H);
  const g = (n: number, text: string, extra: any = {}) => ({ update_id: n, message: { message_id: 100 + n, date: 0, chat: { id: -7, type: "supergroup" }, from: user, text, ...extra } });
  tg.sent = [];
  await call("/tg", g(2, "обычный разговор"), H);
  assert.equal(tg.sent.length, 0);
  await call("/tg", g(3, "@BearLabTaskManager_bot ткань"), H);
  let last = tg.sent.at(-1)!;
  assert.equal(last.body.chat_id, -7);
  assert.equal(last.body.reply_parameters.message_id, 103);
  assert.match(last.body.text, /ткань/);
  tg.sent = [];
  await call("/tg", g(4, "а что по ткани?", { reply_to_message: { message_id: 5, from: { id: 999, is_bot: true, username: "BearLabTaskManager_bot" } } }), H);
  assert.match(tg.sent.at(-1)!.body.text, /ткан/i);
});
