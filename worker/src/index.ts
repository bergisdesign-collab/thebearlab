// Cloudflare Worker entry.
//   POST /tg       Telegram webhook (checked with X-Telegram-Bot-Api-Secret-Token)
//   POST /setup    after each deploy: schema, webhook on this Worker's URL, bot menu (X-Cron-Secret)
//   POST /tick     manual tick for debugging (X-Cron-Secret)
//   cron */10      Notion sync + due jobs (09:00 / 18:00 / Fri 18:00 MSK)
import { App } from "./app.ts";
import { adminIds, realClock } from "./config.ts";
import type { Clock, Env } from "./config.ts";
import * as jobs from "./jobs.ts";
import { NotionClient } from "./notion.ts";
import type { FetchFn, NotionApi } from "./notion.ts";
import { Storage } from "./storage.ts";
import { Syncer, shortReport } from "./sync.ts";
import { TelegramApi, handleUpdate, sendNotices } from "./telegram.ts";

export interface Ctx { waitUntil(p: Promise<unknown>): void }

// Cloudflare Free: 50 subrequests per invocation. Notion gets at most this many, the rest is for Telegram.
const SYNC_BUDGET = 35;
const PUSH_BUDGET = 25;

export interface Deps { clock?: Clock; fetchFn?: FetchFn; notion?: NotionApi | null }

export function runtime(env: Env & { BOT_USERNAME?: string }, deps: Deps = {}) {
  const clock = deps.clock || realClock;
  const st = new Storage(env.DB);
  const notion = deps.notion !== undefined ? deps.notion : env.NOTION_TOKEN ? new NotionClient(env.NOTION_TOKEN, deps.fetchFn) : null;
  const tg = new TelegramApi(env.BOT_TOKEN, deps.fetchFn);
  tg.botUsername = env.BOT_USERNAME;
  const fullSync = async (forceUsers = false): Promise<string> => {
    if (!notion) return "Notion не подключён.";
    // A fresh storage object so a sync never works from a stale request cache.
    const rep = await new Syncer(notion, new Storage(env.DB), clock, notion.calls + SYNC_BUDGET).run(forceUsers);
    for (const e of rep.errors) console.error("sync:", e);
    return shortReport(rep);
  };
  const app = new App(st, clock, { adminIds: adminIds(env), syncFn: notion ? () => fullSync(true) : undefined });
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
    try { out.sync = await fullSync(); } catch (e) { console.error("sync failed", e); out.sync_error = String(e).slice(0, 300); }
    st.refresh();
    const now = clock();
    for (const job of await jobs.due(st, now)) {
      const notices = await jobs.run(job, st, clock);
      await sendNotices(tg, notices);
      await jobs.markDone(st, job, now);
      out[job] = notices.length;
    }
    return out;
  };
  return { clock, st, notion, tg, app, push, tick, fullSync };
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
    try {
      await handleUpdate(update, rt.app, rt.tg);
    } catch (e) {
      console.error("update failed", e);   // still 200, otherwise Telegram retries forever
    }
    ctx.waitUntil(rt.push().catch((e) => console.error("push to Notion failed", e)));
    return new Response("ok");
  }

  if (req.method === "POST" && (url.pathname === "/setup" || url.pathname === "/tick")) {
    if (!secretOk(req.headers.get("X-Cron-Secret"), env.CRON_SECRET)) return new Response("forbidden", { status: 403 });
    const rt = runtime(env, deps);
    if (url.pathname === "/tick") return Response.json(await rt.tick());
    await rt.st.ensureSchema();
    const hook = `https://${url.host}/tg`;
    const wh = await rt.tg.setWebhook(hook, env.WEBHOOK_SECRET);
    const cmds = await rt.tg.setCommands();
    return Response.json({ webhook: hook, ok: wh.ok && cmds.ok, telegram: wh.description || "" });
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
