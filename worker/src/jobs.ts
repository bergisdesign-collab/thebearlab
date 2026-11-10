// Scheduled jobs (Moscow time, config.JOBS). A Cloudflare cron fires every 10 minutes;
// due() decides which jobs to run so each fires once a day, on the first tick after its time:
//   morning  09:00 daily   — team digest to the group + personal plan to each member
//   evening  18:00 daily   — personal reminders about today's / overdue deadlines
//   weekly   18:00 Friday  — week results to the group
// No quiet hours by request; New-year holidays are skipped.
import { JOBS, msk } from "./config.ts";
import type { Clock } from "./config.ts";
import type { Btn, Notice } from "./app.ts";
import * as logic from "./logic.ts";
import { Service } from "./service.ts";
import type { Storage } from "./storage.ts";
import * as texts from "./texts.ts";

const MORNING_KB: Btn[][] = [[{ text: "Мои задачи", data: "go:my" }, { text: "Что дальше", data: "go:next" }]];

export async function due(st: Storage, now: Date): Promise<string[]> {
  const t = msk(now);
  const minutes = t.hour * 60 + t.minute;
  const out: string[] = [];
  for (const [name, j] of Object.entries(JOBS)) {
    if (j.weekday !== null && t.weekday !== j.weekday) continue;
    const start = j.hour * 60 + j.minute;
    if (minutes >= start && minutes < start + 120 && !(await st.kvGet(`ran:${name}:${t.date}`))) out.push(name);
  }
  return out;
}

export async function markDone(st: Storage, job: string, now: Date): Promise<void> {
  const t = msk(now);
  await st.kvSet(`ran:${job}:${t.date}`, t.iso);
}

export interface JobExtras { weeklyReview?: () => Promise<string> }

export async function run(job: string, st: Storage, clock: Clock, extras: JobExtras = {}): Promise<Notice[]> {
  const svc = new Service(st, clock);
  const today = msk(clock()).date;
  if (logic.isHoliday(today)) return [];
  const changes = await svc.refreshMilestones();
  await svc.recordToday();
  const group = await st.kvGet<number>("group_chat");
  const members = (await st.members()).filter((m) => m.approved);
  const out: Notice[] = [];

  if (job === "morning") {
    if (group) {
      let text = await texts.teamDigest(st, today);
      if (changes.length) text += "\n\n<b>Изменились статусы вех:</b>\n" + changes.map(([t, o, n]) => `• ${texts.esc(t)}: ${o} → ${n}`).join("\n");
      out.push({ chatId: Number(group), text, kb: [[{ text: "Свободные задачи", data: "go:free" }]] });
    }
    for (const m of members) {
      const msg = await texts.personal(st, m, today);
      if (msg) out.push({ chatId: m.tg_id, text: msg, kb: MORNING_KB });
    }
  } else if (job === "evening") {
    for (const m of members) {
      const msg = await texts.personal(st, m, today, true);
      if (msg) out.push({ chatId: m.tg_id, text: msg, kb: [[{ text: "Мои задачи", data: "go:my" }]] });
    }
    if (group) {
      const od = logic.overdue(await st.tasks(), today);
      const s = logic.streak(await st.days(), today);
      if (od.length) out.push({ chatId: Number(group), text: `Вечерняя сверка: просрочено ${od.length}. Закройте или перенесите, чтобы не потерять серию.`, kb: [] });
      else if (s) out.push({ chatId: Number(group), text: `День без просрочек ✅ Серия: ${logic.daysStr(s)}.`, kb: [] });
    }
  } else if (job === "weekly") {
    if (group) {
      out.push({ chatId: Number(group), text: await texts.weekly(st, today), kb: [[{ text: "Роадмап", data: "go:plan" }]] });
      if (extras.weeklyReview) {
        try {
          const review = await extras.weeklyReview();
          if (review) out.push({ chatId: Number(group), text: texts.clip(`<b>🧠 Разбор недели</b>\n\n${review}`), kb: [] });
        } catch (e) {
          console.error("weekly review failed", e);
        }
      }
    }
  }
  return out;
}
