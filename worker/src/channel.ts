// A Telegram channel with the history of the work: a live feed of what was done, set and taken
// (posted on the cron tick, batched) and a daily diary at 21:00 with what's ahead.
// Notes and check-in answers are never posted: they can be private.
import { addDays, msk } from "./config.ts";
import type { Clock } from "./config.ts";
import type { Notice } from "./app.ts";
import * as logic from "./logic.ts";
import { isDone } from "./models.ts";
import type { Event } from "./models.ts";
import type { Storage } from "./storage.ts";
import { Names, esc, shortDate } from "./texts.ts";

const ICON: Record<string, string> = {
  create: "➕", done: "✅", take: "🙋", assign: "👥", join: "🤝", leave: "↩️", release: "↩️", due: "📅", result: "🔗", status: "🔄",
};
const MAX_LINES = 25;

export async function channelId(st: Storage): Promise<number | null> {
  const id = await st.kvGet<number>("log_channel");
  return id ? Number(id) : null;
}

/** New events since the last post, as one message (null when there is nothing to post). */
export async function feedPost(st: Storage, clock: Clock): Promise<{ notice: Notice; cursor: string } | null> {
  const chat = await channelId(st);
  if (!chat) return null;
  const cursor = (await st.kvGet<string>("channel_cursor")) || msk(clock()).iso;
  const evs = (await st.events(cursor)).filter((e) => e.ts > cursor && ICON[e.kind]);
  if (!evs.length) return null;
  const tasks = new Map((await st.tasks(true)).map((t) => [t.id, t]));
  // a burst of edits on one task collapses: keep its last status-like event plus a done/create if any
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const e of [...evs].reverse()) {
    const key = `${e.task_id}:${e.kind === "done" || e.kind === "create" ? e.kind : "x"}:${e.actor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.unshift(feedLine(e, tasks.get(e.task_id)?.title || "задача"));
  }
  const now = msk(clock());
  const shown = lines.slice(-MAX_LINES);
  const more = lines.length - shown.length;
  const text = `🧸 <b>Лента TheBearLab</b> · ${shortDate(now.date)} ${now.iso.slice(11, 16)}\n\n${shown.join("\n")}${more > 0 ? `\n…и ещё ${more}` : ""}`;
  return { notice: { chatId: chat, text, kb: [] }, cursor: evs.at(-1)!.ts };
}

function feedLine(e: Event, title: string): string {
  return `${ICON[e.kind]} <b>${esc(e.actor)}</b>: «${esc(title)}» — ${esc(e.text)}`;
}

/** The evening diary: progress, what got done and set today, what's ahead this week. */
export async function diaryPost(st: Storage, today: string): Promise<Notice | null> {
  const chat = await channelId(st);
  if (!chat) return null;
  const tasks = await st.tasks();
  const all = new Map((await st.tasks(true)).map((t) => [t.id, t]));
  const names = await Names.load(st);
  const evs = await st.events(today);
  const doneToday = [...new Set(evs.filter((e) => e.kind === "done").map((e) => e.task_id))].map((id) => all.get(id)).filter(Boolean);
  const newToday = [...new Set(evs.filter((e) => e.kind === "create").map((e) => e.task_id))].map((id) => all.get(id)).filter(Boolean);
  const [done, total, pct] = logic.progress(tasks);
  const ahead = tasks.filter((t) => !isDone(t) && t.due && t.due > today && t.due <= addDays(today, 7)).sort((a, b) => a.due!.localeCompare(b.due!));
  const od = logic.overdue(tasks, today);
  const days = logic.daysToLaunch(await st.milestones(), today);
  const who = (t: { id: string }) => { const x = all.get(t.id)!; const n = names.of(x); return n ? ` — ${esc(n)}` : " — свободна"; };
  const lines = [
    `📒 <b>Дневник TheBearLab · ${shortDate(today)}</b>`,
    `${logic.bar(pct)} ${pct}% · готово ${done} из ${total}${days !== null ? ` · до запуска ${logic.daysStr(days)}` : ""}`,
  ];
  lines.push("", `<b>✅ Сделано сегодня (${doneToday.length})</b>`, ...(doneToday.length ? doneToday.slice(0, 12).map((t) => `• ${esc(t!.title)}${who(t!)}`) : ["• пока без закрытых задач"]));
  if (newToday.length) lines.push("", `<b>➕ Поставили (${newToday.length})</b>`, ...newToday.slice(0, 10).map((t) => `• ${esc(t!.title)}${t!.due ? ` · до ${shortDate(t!.due)}` : ""}`));
  if (ahead.length) lines.push("", `<b>🔜 Впереди на неделе (${ahead.length})</b>`, ...ahead.slice(0, 12).map((t) => `• ${shortDate(t.due)} ${esc(t.title)}${who(t)}`));
  if (od.length) lines.push("", `⏰ Просрочено: ${od.length}`);
  return { chatId: chat, text: lines.join("\n"), kb: [] };
}
