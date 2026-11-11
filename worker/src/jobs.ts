// Scheduled jobs (Moscow time, config.JOBS). A Cloudflare cron fires every 10 minutes;
// due() decides which jobs to run so each fires once a day, on the first tick after its time:
//   morning  09:00 daily   — team digest to the group + personal plan to each member
//   evening  18:00 daily   — personal reminders about today's / overdue deadlines
//   weekly   18:00 Friday  — week results to the group, with the burndown chart
//   checkin  19:00 daily   — «что сегодня продвинулось?» to everyone with tasks
//   monday   10:00 Monday  — plan of the week, confirmed with buttons
//   selfcheck 12:00 daily  — health check, admins hear only about problems
// Each person chooses what they get (/settings); the group switches are the admin's.
// No quiet hours by request; New-year holidays are skipped.
import { JOBS, msk } from "./config.ts";
import type { Clock } from "./config.ts";
import type { Btn, Notice } from "./app.ts";
import * as logic from "./logic.ts";
import { Service } from "./service.ts";
import type { Storage } from "./storage.ts";
import * as texts from "./texts.ts";
import * as rich from "./rich.ts";
import { isDone } from "./models.ts";
import { getGroupPrefs, getPrefs } from "./prefs.ts";
import { burndown, burndownLine, chartUrl } from "./burndown.ts";
import { heuristicPlan, planInput, planNotice } from "./plan.ts";
import type { PlanInput, PlanItem } from "./plan.ts";

const MORNING_KB: Btn[][] = [[{ text: "Мой кабинет", data: "go:my" }, { text: "Что дальше", data: "go:next" }]];

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

/** The daily self-check runs even on holidays; it only tells admins about problems. */
export async function selfcheck(st: Storage, extras: JobExtras): Promise<Notice[]> {
  const found = extras.health ? await extras.health() : [];
  if (!found.length) return [];
  const admins = (await st.members()).filter((m) => m.admin && m.approved);
  return admins.map((a) => ({ chatId: a.tg_id, text: "🩺 <b>Самопроверка бота</b>\n" + found.map((x) => "• " + texts.esc(x)).join("\n"), kb: [] }));
}

export async function markDone(st: Storage, job: string, now: Date): Promise<void> {
  const t = msk(now);
  await st.kvSet(`ran:${job}:${t.date}`, t.iso);
}

export interface JobExtras {
  weeklyReview?: () => Promise<string>;
  planWeek?: (inp: PlanInput, today: string) => Promise<PlanItem[]>;
  health?: () => Promise<string[]>;
}

export async function run(job: string, st: Storage, clock: Clock, extras: JobExtras = {}): Promise<Notice[]> {
  if (job === "selfcheck") return selfcheck(st, extras);
  const svc = new Service(st, clock);
  const today = msk(clock()).date;
  if (logic.isHoliday(today)) return [];
  const changes = await svc.refreshMilestones();
  await svc.recordToday();
  const gp = await getGroupPrefs(st);
  const bound = await st.kvGet<number>("group_chat");
  const group = gp.digest ? bound : null;
  const all = (await st.members()).filter((m) => m.approved);
  const prefs = new Map(await Promise.all(all.map(async (m) => [m.tg_id, await getPrefs(st, m.tg_id)] as const)));
  const members = all.filter((m) => (job === "morning" ? prefs.get(m.tg_id)!.morning : job === "evening" ? prefs.get(m.tg_id)!.evening : job === "checkin" ? prefs.get(m.tg_id)!.checkin : true));
  const out: Notice[] = [];

  if (job === "morning") {
    if (group) {
      let text = await texts.teamDigest(st, today);
      if (changes.length) text += "\n\n<b>Изменились статусы вех:</b>\n" + changes.map(([t, o, n]) => `• ${texts.esc(t)}: ${o} → ${n}`).join("\n");
      let r = await rich.digest(st, today);
      if (changes.length) r += "\n\n#### Изменились статусы вех\n" + changes.map(([t, o, n]) => `- ${rich.md(t)}: ${o} → ${n}`).join("\n");
      out.push({ chatId: Number(group), text, kb: [[{ text: "Свободные задачи", data: "go:free" }]], rich: r });
    }
    for (const m of members) {
      const msg = await texts.personal(st, m, today);
      if (msg) out.push({ chatId: m.tg_id, text: msg, kb: MORNING_KB });
    }
  } else if (job === "evening") {
    for (const m of members) {
      const msg = await texts.personal(st, m, today, true);
      if (msg) out.push({ chatId: m.tg_id, text: msg, kb: [[{ text: "Мой кабинет", data: "go:my" }]] });
    }
    if (group) {
      const od = logic.overdue(await st.tasks(), today);
      const s = logic.streak(await st.days(), today);
      if (od.length) out.push({ chatId: Number(group), text: `Вечерняя сверка: просрочено ${od.length}. Закройте или перенесите, чтобы не потерять серию.`, kb: [] });
      else if (s) out.push({ chatId: Number(group), text: `День без просрочек ✅ Серия: ${logic.daysStr(s)}.`, kb: [] });
    }
  } else if (job === "weekly") {
    if (group) {
      out.push({ chatId: Number(group), text: await texts.weekly(st, today), kb: [[{ text: "Роадмап", data: "go:plan" }]], rich: await rich.weekly(st, today) });
      const b = burndown(await st.days(), today, (await st.tasks()).filter((t) => !isDone(t)).length);
      out.push({ chatId: Number(group), photo: chartUrl(b), text: `📉 <b>График прогресса</b>\n${texts.esc(burndownLine(b))}`, kb: [] });
      if (extras.weeklyReview) {
        try {
          const review = await extras.weeklyReview();
          if (review) out.push({ chatId: Number(group), text: texts.clip(`<b>🧠 Разбор недели</b>\n\n${review}`), kb: [] });
        } catch (e) {
          console.error("weekly review failed", e);
        }
      }
    }
  } else if (job === "checkin") {
    const tasks = await st.tasks();
    for (const m of members) {
      const mine = tasks.filter((t) => logic.isMine(t, m.tg_id) && !isDone(t));
      if (!mine.length) continue;
      await st.kvSet(`await:${m.tg_id}`, { a: "checkin", d: today });
      const inWork = mine.filter((t) => t.status === "В работе").slice(0, 5);
      out.push({
        chatId: m.tg_id,
        text: `🌙 <b>${texts.esc(m.name)}, что сегодня продвинулось?</b>\nОтветь одним сообщением — текстом или голосом. Я разнесу по журналам задач и поправлю статусы.${inWork.length ? "\n\nВ работе: " + inWork.map((t) => "«" + texts.esc(t.title) + "»").join(", ") : ""}`,
        kb: [[{ text: "Сегодня без продвижения", data: "ci:none" }]],
      });
    }
  } else if (job === "monday") {
    if (bound && gp.monday) {
      const inp = await planInput(st, today);
      let items: PlanItem[] = [];
      if (extras.planWeek && inp.candidates.length) {
        try { items = await extras.planWeek(inp, today); } catch (e) { console.error("plan by AI failed", e); }
      }
      if (!items.length) items = heuristicPlan(inp, today);
      if (items.length) {
        const plan = { date: today, items };
        await st.kvSet("week_plan", plan);
        out.push(planNotice(plan, new Map(inp.tasks.map((t) => [t.id, t])), new Map(inp.members.map((m) => [m.tg_id, m.name])), Number(bound)));
      }
    }
  }
  return out;
}
