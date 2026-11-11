// Cloudflare Worker entry.
//   POST /tg       Telegram webhook (checked with X-Telegram-Bot-Api-Secret-Token)
//   POST /setup    after each deploy: schema, webhook on this Worker's URL, bot menu (X-Cron-Secret)
//   POST /tick     manual tick for debugging (X-Cron-Secret)
//   cron */10      Notion sync, personal reminders, pinned summary, due jobs (see jobs.ts)
import { AnthropicClient, Assistant, transcribe, transcribeCloudflare } from "./ai.ts";
import { bufferGroupMessage, groupBufferSize, takeGroupBuffer } from "./memory.ts";
import { handleBoardQuery, sendBoard } from "./board.ts";
import type { LlmApi } from "./ai.ts";
import { App } from "./app.ts";
import { adminIds, realClock } from "./config.ts";
import type { Clock, Env } from "./config.ts";
import * as jobs from "./jobs.ts";
import { NotionClient, pageText } from "./notion.ts";
import { adminAlert, countError, problems } from "./alerts.ts";
import { refreshPinned } from "./pinned.ts";
import { feedPost } from "./channel.ts";
import { getGroupPrefs } from "./prefs.ts";
import { takeDueReminders } from "./reminders.ts";
import { msk } from "./config.ts";
import type { FetchFn, NotionApi } from "./notion.ts";
import { Storage } from "./storage.ts";
import { getPrefs } from "./prefs.ts";
import { Syncer, shortReport } from "./sync.ts";
import { TelegramApi, handleUpdate, sendNotices } from "./telegram.ts";
import type { PanelStore } from "./telegram.ts";

export interface Ctx { waitUntil(p: Promise<unknown>): void }

// Cloudflare Free: 50 subrequests per invocation. Notion gets at most this many, the rest is for Telegram.
const SYNC_BUDGET = 35;
const PUSH_BUDGET = 25;

export interface Deps { clock?: Clock; fetchFn?: FetchFn; notion?: NotionApi | null; llm?: LlmApi | null }

export function runtime(env: Env, deps: Deps = {}) {
  const clock = deps.clock || realClock;
  const st = new Storage(env.DB);
  const notion = deps.notion !== undefined ? deps.notion : env.NOTION_TOKEN ? new NotionClient(env.NOTION_TOKEN, deps.fetchFn) : null;
  const tg = new TelegramApi(env.BOT_TOKEN, deps.fetchFn);
  tg.botUsername = env.BOT_USERNAME;
  tg.onPrivatePost = (chatId) => st.kvDel(`panel:${chatId}`);
  const fullSync = async (forceUsers = false): Promise<string> => {
    if (!notion) return "Notion не подключён.";
    // A fresh storage object so a sync never works from a stale request cache.
    const s2 = new Storage(env.DB);
    const rep = await new Syncer(notion, s2, clock, notion.calls + SYNC_BUDGET).run(forceUsers);
    for (const e of rep.errors) console.error("sync:", e);
    for (const [tid, uid] of rep.assigned || []) {
      const t = await s2.task(tid);
      if (t && (await getPrefs(s2, uid)).cabinet) await sendNotices(tg, [await app.cabinetCard(t, uid, "Тебя назначили в Notion")]);
    }
    if (rep.errors.length) {
      const fails = ((await s2.kvGet<number>("sync_fails")) || 0) + 1;
      await s2.kvSet("sync_fails", fails);
      if (fails >= 3) await sendNotices(tg, await adminAlert(s2, clock, "sync", `Синхронизация с Notion ${fails} раз подряд с ошибками: ${rep.errors.slice(0, 2).join("; ").slice(0, 300)}`));
    } else {
      await s2.kvSet("last_sync", clock().getTime());
      await s2.kvSet("sync_fails", 0);
    }
    return shortReport(rep);
  };
  const today = () => msk(clock()).date;
  const alert = async (key: string, text: string) => sendNotices(tg, await adminAlert(st, clock, key, text));
  const bodyOf = (t: import("./models.ts").Task) => pageText(notion, st, t);
  const app = new App(st, clock, { adminIds: adminIds(env), syncFn: notion ? () => fullSync(true) : undefined });
  if (notion) app.pageTextFn = bodyOf;
  const llm = deps.llm !== undefined ? deps.llm : env.ANTHROPIC_API_KEY ? new AnthropicClient(env.ANTHROPIC_API_KEY, deps.fetchFn) : null;
  if (llm) {
    app.askFn = async (m, text, o) => {
      try {
        const a = new Assistant(app, llm, clock);
        if (o?.group) a.source = "Общий чат";
        if (notion) a.pageText = bodyOf;
        return await a.ask(m, text, { chatId: o?.chatId, checkin: o?.checkin });
      } catch (e) {
        console.error("ai failed", e);
        const n = await countError(st, "ai", today());
        const msg = String((e as Error)?.message || e);
        if (/credit|balance|billing|401|403|invalid x-api-key/i.test(msg)) await alert("ai_key", `ИИ-консультант не работает: ${msg.slice(0, 200)}. Проверь ключ и баланс Anthropic.`);
        else if (n >= 3) await alert("ai_errors", `ИИ-консультант ошибся ${n} раз за сегодня. Последняя ошибка: ${msg.slice(0, 200)}`);
        return { screen: { text: "ИИ-консультант сейчас не ответил — попробуй через минуту. Пока можно воспользоваться меню или /find.", kb: [] }, notices: [] };
      }
    };
  }
  const voice = env.AI
    ? async (audio: ArrayBuffer) => {
      try {
        return await transcribeCloudflare(audio, env.AI!);
      } catch (e) {
        if (!env.OPENAI_API_KEY) throw e;
        console.warn("Workers AI whisper failed, trying OpenAI", e);
        return transcribe(audio, env.OPENAI_API_KEY, deps.fetchFn);
      }
    }
    : env.OPENAI_API_KEY ? (audio: ArrayBuffer) => transcribe(audio, env.OPENAI_API_KEY!, deps.fetchFn) : undefined;
  const weeklyReview = llm ? () => new Assistant(app, llm, clock).weeklyReview() : undefined;
  const planWeek = llm ? (inp: import("./plan.ts").PlanInput, d: string) => new Assistant(app, llm, clock).planWeek(inp, d) : undefined;
  const health = async (): Promise<string[]> => {
    const wh = await tg.call("getWebhookInfo", {}).catch(() => null);
    const y = msk(new Date(clock().getTime() - 86400000)).date;
    const errs = async (k: string) => ((await st.kvGet<number>(`err:${k}:${today()}`)) || 0) + ((await st.kvGet<number>(`err:${k}:${y}`)) || 0);
    return problems({
      lastSyncMs: (await st.kvGet<number>("last_sync")) ?? null,
      syncFails: (await st.kvGet<number>("sync_fails")) || 0,
      webhook: wh?.ok ? (wh as any).result : undefined,
      aiErrors: await errs("ai"), jobErrors: await errs("job"),
    }, clock().getTime(), !!notion);
  };
  // /channel asked to connect a channel: check it here, where Telegram can be asked
  const channelBind = async (): Promise<void> => {
    const p = await st.kvGet<{ raw: string; by: number }>("channel_pending");
    if (!p) return;
    await st.kvDel("channel_pending");
    const chat: any = await tg.call("getChat", { chat_id: /^-?\d+$/.test(p.raw) ? Number(p.raw) : p.raw });
    if (!chat.ok || chat.result?.type !== "channel") {
      await tg.sendMessage(p.by, `Не нашёл такой канал${chat.description ? ` (${chat.description})` : ""}. Проверь имя и что я добавлен в канал администратором.`);
      return;
    }
    const id = Number(chat.result.id);
    const test: any = await tg.call("sendMessage", { chat_id: id, text: "🧸 Здесь будет история работы TheBearLab: что сделано, что поставили и что впереди.", disable_notification: true });
    if (!test.ok) {
      await tg.sendMessage(p.by, `Канал нашёл, но писать туда не могу: ${test.description || "нет прав"}. Сделай меня администратором канала с правом «Публикация сообщений» и пришли /channel ещё раз.`);
      return;
    }
    await st.kvSet("log_channel", id);
    await st.kvSet("channel_cursor", msk(clock()).iso);
    await tg.sendMessage(p.by, `Канал «${(chat.result.title || "").replace(/</g, "&lt;")}» подключён ✅ Лента действий пойдёт туда каждые 10 минут, дневник дня — в 21:00. Выключить отдельно можно в /settings.`);
  };
  const feed = async (): Promise<number> => {
    if (!(await getGroupPrefs(st)).feed) return 0;
    const post = await feedPost(st, clock);
    if (!post) return 0;
    const r: any = await tg.call("sendMessage", { chat_id: post.notice.chatId, text: post.notice.text, parse_mode: "HTML", disable_notification: true, link_preview_options: { is_disabled: true } });
    if (r.ok) { await st.kvSet("channel_cursor", post.cursor); return 1; }
    await alert("channel", `Не получается писать в канал с историей: ${r.description || "ошибка"}. Проверь, что бот — администратор канала.`);
    return 0;
  };
  const pinned = async (): Promise<string> => {
    try { return await refreshPinned(st, tg, clock); } catch (e) { console.error("pinned failed", e); return "error"; }
  };
  // Ordinary messages of the bound group are kept briefly, only to extract conclusions (then deleted).
  const bufferGroup = llm ? async (chatId: number, who: string, text: string) => {
    if (Number(await st.kvGet("group_chat")) === chatId && (await st.members()).some((x) => x.approved)) {
      await bufferGroupMessage(st, clock, chatId, who, text);
    }
  } : undefined;
  const extractConclusions = async (): Promise<number> => {
    const group = Number(await st.kvGet("group_chat"));
    if (!llm || !group) return 0;
    const size = await groupBufferSize(st, group);
    const last = (await st.kvGet<number>("extract_at")) || 0;
    const age = clock().getTime() - last;
    if (size > 0 && size < 3 && age > 24 * 3600 * 1000) { await takeGroupBuffer(st, group); await st.kvSet("extract_at", clock().getTime()); return 0; }   // nothing worth it: just forget
    if (size < 3 || (size < 20 && age < 2 * 3600 * 1000)) return 0;
    await st.kvSet("extract_at", clock().getTime());
    const saved = await new Assistant(app, llm, clock).extractFromGroup(await takeGroupBuffer(st, group));
    if (saved.length) {
      await sendNotices(tg, [{ chatId: group, text: "📝 <b>Запомнил из обсуждения</b>\n" + saved.map((x) => "• " + x.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("\n"),
        kb: [[{ text: "🧠 Вся память", data: "go:memory" }]] }]);
    }
    return saved.length;
  };
  const push = async (): Promise<void> => {
    if (!notion) return;
    const s = new Syncer(notion, new Storage(env.DB), clock, notion.calls + PUSH_BUDGET);
    if (await s.hasLocalChanges()) {
      const rep = await s.push();
      for (const e of rep.errors) console.error("push:", e);
    }
  };
  const tick = async (): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {};
    try { out.sync = await fullSync(); } catch (e) {
      console.error("sync failed", e);
      out.sync_error = String(e).slice(0, 300);
      const fails = ((await st.kvGet<number>("sync_fails")) || 0) + 1;
      await st.kvSet("sync_fails", fails);
      if (fails >= 3) await alert("sync", `Синхронизация с Notion падает ${fails} раз подряд: ${String(e).slice(0, 200)}`);
    }
    st.refresh();
    try {
      const due = await takeDueReminders(st, clock);
      if (due.length) { await sendNotices(tg, due); out.reminders = due.length; }
    } catch (e) { console.error("reminders failed", e); }
    const now = clock();
    for (const job of await jobs.due(st, now)) {
      try {
        const notices = await jobs.run(job, st, clock, { weeklyReview, planWeek, health });
        await sendNotices(tg, notices);
        out[job] = notices.length;
      } catch (e) {
        console.error("job failed", job, e);
        await countError(st, "job", today());
        await alert("job_" + job, `Плановая рассылка «${job}» упала: ${String(e).slice(0, 200)}`);
      }
      await jobs.markDone(st, job, now);
    }
    out.pinned = await pinned();
    try { out.feed = await feed(); } catch (e) { console.error("feed failed", e); }
    try { out.remembered = await extractConclusions(); } catch (e) { console.error("extract failed", e); }
    return out;
  };
  const panel: PanelStore = {
    enabled: async (uid) => (await getPrefs(st, uid)).window,
    get: (chatId) => st.kvGet<number>(`panel:${chatId}`),
    set: (chatId, id) => st.kvSet(`panel:${chatId}`, id),
  };
  const board = async (chatId: number, from: { id: number; name: string; username?: string }, isPrivate: boolean): Promise<void> => {
    const m = await app.memberOf(from);
    if (!m) { await tg.sendMessage(chatId, "Сначала отправь мне /start в личных сообщениях."); return; }
    if (!isPrivate) { await tg.sendMessage(chatId, "Живая доска работает в личке со мной — открой меня и нажми /board."); return; }
    if (!(await sendBoard(app, tg, chatId, m))) await tg.sendMessage(chatId, "Не получилось показать доску. Обнови Telegram до последней версии — виджеты появились совсем недавно.");
  };
  const widget = async (q: any): Promise<void> => { await sendNotices(tg, await handleBoardQuery(app, tg, q)); };
  return { clock, st, notion, tg, app, push, tick, fullSync, voice, bufferGroup, panel, board, widget, pinned, health, channelBind };
}

function secretOk(got: string | null, expected?: string): boolean {
  if (!expected) return false;
  if (!got || got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function handleFetch(req: Request, env: Env, ctx: Ctx, deps: Deps = {}): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/") return new Response("the Bear Lab Bot: ok");

  if (req.method === "POST" && url.pathname === "/tg") {
    if (env.WEBHOOK_SECRET && !secretOk(req.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.WEBHOOK_SECRET)) {
      return new Response("forbidden", { status: 403 });
    }
    const update = await req.json();
    const rt = runtime(env, deps);
    // Answer Telegram at once and do the work after: AI answers can take several seconds.
    ctx.waitUntil((async () => {
      try {
        rt.tg.botUsername ||= (await rt.st.kvGet<string>("bot_username")) || undefined;
        await handleUpdate(update, rt.app, rt.tg, { transcribe: rt.voice, bufferGroup: rt.bufferGroup, panel: rt.panel, board: rt.board, widget: rt.widget });
      } catch (e) {
        console.error("update failed", e);
      }
      try {
        await rt.push();
      } catch (e) {
        console.error("push to Notion failed", e);
      }
      await rt.pinned();
      try { await rt.channelBind(); } catch (e) { console.error("channel bind failed", e); }
    })());
    return new Response("ok");
  }

  if (req.method === "POST" && (url.pathname === "/setup" || url.pathname === "/tick")) {
    if (!secretOk(req.headers.get("X-Cron-Secret"), env.CRON_SECRET)) return new Response("forbidden", { status: 403 });
    const rt = runtime(env, deps);
    if (url.pathname === "/tick") return Response.json(await rt.tick());
    await rt.st.ensureSchema();
    const hook = `https://${url.host}/tg`;
    const wh = await rt.tg.setWebhook(hook, env.WEBHOOK_SECRET);
    const username = await rt.tg.username();
    if (username) await rt.st.kvSet("bot_username", username);
    const cmds = await rt.tg.setCommands();
    return Response.json({ webhook: hook, ok: wh.ok && cmds.ok, telegram: wh.description || "", username });
  }

  return new Response("not found", { status: 404 });
}

export default {
  fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handleFetch(req, env, ctx);
  },
  async scheduled(_event: unknown, env: Env, ctx: Ctx): Promise<void> {
    ctx.waitUntil(runtime(env).tick().then((r) => console.log("tick", JSON.stringify(r))));
  },
};
