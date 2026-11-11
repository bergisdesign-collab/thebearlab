// Pure roadmap logic: progress, streaks, mentor scoring, milestone risk, search, dates.
import { HOLIDAY_END, HOLIDAY_START, LAUNCH_DATE, LAUNCH_MILESTONE, addDays, daysBetween } from "./config.ts";
import { PRIORITIES, isDone } from "./models.ts";
import type { Idea, Milestone, Task } from "./models.ts";

export const isHoliday = (d: string): boolean => d >= HOLIDAY_START && d <= HOLIDAY_END;

/** Deadlines never land on the New-year break: move them to the first working day after. */
export const skipHolidays = (d: string): string => (isHoliday(d) ? addDays(HOLIDAY_END, 1) : d);

export function plural(n: number, forms: [string, string, string]): string {
  n = Math.abs(n);
  if (n % 10 === 1 && n % 100 !== 11) return forms[0];
  if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) return forms[1];
  return forms[2];
}

export const DAYS: [string, string, string] = ["день", "дня", "дней"];
export const TASKS: [string, string, string] = ["задача", "задачи", "задач"];
export const daysStr = (n: number): string => `${n} ${plural(n, DAYS)}`;

// --- progress ---------------------------------------------------------------

export function progress(tasks: Task[]): [number, number, number] {
  const done = tasks.filter(isDone).length;
  const total = tasks.length;
  return [done, total, total ? Math.round((100 * done) / total) : 0];
}

export function bar(pct: number, width = 12): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct * width) / 100)));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

const byDue = (a: Task, b: Task): number => (a.due || "9999").localeCompare(b.due || "9999");

export const overdue = (tasks: Task[], today: string): Task[] =>
  tasks.filter((t) => !isDone(t) && t.due && t.due < today).sort(byDue);

export const dueOn = (tasks: Task[], day: string): Task[] => tasks.filter((t) => !isDone(t) && t.due === day);

export function dueWithin(tasks: Task[], today: string, days: number): Task[] {
  const end = addDays(today, days);
  return tasks.filter((t) => !isDone(t) && t.due && t.due >= today && t.due <= end).sort(byDue);
}

export function openDeps(t: Task, byId: Map<string, Task>): Task[] {
  return t.depends_on.map((d) => byId.get(d)).filter((x): x is Task => !!x && !isDone(x));
}

export const blockedTasks = (t: Task, tasks: Task[]): Task[] =>
  tasks.filter((x) => x.depends_on.includes(t.id) && !isDone(x));

export const isFree = (t: Task): boolean => !t.assignee_tg && !t.assignee_notion;

export function daysToLaunch(milestones: Milestone[], today: string): number {
  let d = LAUNCH_DATE;
  for (const m of milestones) if (m.title.trim().toLowerCase() === LAUNCH_MILESTONE.toLowerCase() && m.date) d = m.date;
  return daysBetween(today, d);
}

// --- streak -----------------------------------------------------------------

export interface DayRec { overdue: number; done: number; by_member: Record<string, number>; total?: number }

/** Consecutive recorded days without overdue tasks, ending today (or yesterday if today is not
 * recorded yet). Holidays are transparent: they neither count nor break the streak. */
export function streak(days: Record<string, DayRec>, today: string, memberKey?: string): number {
  const keys = Object.keys(days);
  if (!keys.length) return 0;
  const earliest = keys.sort()[0];
  let d = days[today] ? today : addDays(today, -1);
  let n = 0;
  while (d >= earliest) {
    const rec = days[d];
    if (!rec) {
      if (isHoliday(d)) { d = addDays(d, -1); continue; }
      break;
    }
    const ov = memberKey === undefined ? rec.overdue || 0 : (rec.by_member || {})[memberKey] || 0;
    if (ov) break;
    if (!isHoliday(d)) n += 1;
    d = addDays(d, -1);
  }
  return n;
}

export function overdueByMember(tasks: Task[], today: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of overdue(tasks, today)) {
    if (t.assignee_tg) out[String(t.assignee_tg)] = (out[String(t.assignee_tg)] || 0) + 1;
  }
  return out;
}

// --- milestones -------------------------------------------------------------

export const milestoneTasks = (m: Milestone, tasks: Task[]): Task[] => tasks.filter((t) => t.milestones.includes(m.id));

export function milestoneStatus(m: Milestone, tasks: Task[], today: string): string {
  const linked = milestoneTasks(m, tasks);
  if (!linked.length) return m.status;
  const done = linked.filter(isDone).length;
  if (done === linked.length) return "Достигнута";
  if (m.date && m.date < today) return "Сорвана";
  if (overdue(linked, today).length) return "Под угрозой";
  if (m.date && daysBetween(today, m.date) <= 7 && done / linked.length < 0.7) return "Под угрозой";
  return "Впереди";
}

export function nextMilestone(milestones: Milestone[], today: string): Milestone | null {
  const up = milestones.filter((m) => m.date && m.date >= today && m.status !== "Достигнута");
  up.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  return up[0] || null;
}

// --- mentor -----------------------------------------------------------------

/** Main assignee or partner. */
export function isMine(t: Task, tgId: number | null): boolean {
  return tgId !== null && (t.assignee_tg === tgId || (t.co_tg || []).includes(tgId));
}

/** Done together by two or more people. */
export function isJoint(t: Task): boolean {
  return !!(t.assignee_tg || t.assignee_notion) && ((t.co_tg || []).length > 0 || (t.co_notion || []).length > 0);
}

export function scoreTask(t: Task, tasks: Task[], msById: Map<string, Milestone>, tgId: number | null,
                          today: string): [number, string[]] {
  const reasons: string[] = [];
  let score = (PRIORITIES[t.priority] ?? 2) * 10;
  const mine = isMine(t, tgId);
  if (mine && t.status === "В работе") { score += 100; reasons.push("ты уже ведёшь её"); }
  else if (mine) { score += 20; reasons.push("назначена на тебя"); }
  if (t.priority === "Высокий") reasons.push("высокий приоритет");
  if (t.due) {
    const d = daysBetween(today, t.due);
    if (d < 0) { score += 50; reasons.push(`просрочена на ${daysStr(-d)}`); }
    else if (d === 0) { score += 30; reasons.push("срок сегодня"); }
    else if (d <= 2) { score += 30; reasons.push(`срок через ${daysStr(d)}`); }
    else if (d <= 7) { score += 15; reasons.push(`срок через ${daysStr(d)}`); }
  }
  for (const mid of t.milestones) {
    const m = msById.get(mid);
    if (m && m.date) {
      const d = daysBetween(today, m.date);
      if (d >= 0 && d <= 14) { score += 10; reasons.push(`веха «${m.title}» через ${daysStr(d)}`); break; }
    }
  }
  const b = blockedTasks(t, tasks).length;
  if (b) { score += 5 * b; reasons.push(`разблокирует ${b} ${plural(b, TASKS)}`); }
  if (t.type === "Решение") { score += 5; reasons.push("нужно принять решение"); }
  return [score, reasons];
}

export interface Suggestion { task: Task; score: number; reasons: string[] }

/** What to do next. Only tasks whose dependencies are done and that are free or mine. */
export function suggest(tasks: Task[], milestones: Milestone[], tgId: number | null, today: string, limit = 3): Suggestion[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const msById = new Map(milestones.map((m) => [m.id, m]));
  const out: Suggestion[] = [];
  for (const t of tasks) {
    if (isDone(t) || t.status === "На проверке") continue;
    const mine = isMine(t, tgId);
    if (!mine && !isFree(t)) continue;
    if (openDeps(t, byId).length) continue;
    const [score, reasons] = scoreTask(t, tasks, msById, tgId, today);
    out.push({ task: t, score, reasons });
  }
  out.sort((a, b) => b.score - a.score || (a.task.due || "9999").localeCompare(b.task.due || "9999")
    || a.task.title.localeCompare(b.task.title));
  return out.slice(0, limit);
}

// --- search -----------------------------------------------------------------

const tokens = (s: string): string[] =>
  ((s || "").match(/[\p{L}\p{N}_]+/gu) || []).filter((w) => w.length > 1).map((w) => w.toLowerCase().replace(/ё/g, "е"));

function match(q: string[], text: string): number {
  const words = tokens(text);
  let score = 0;
  for (const w of q) {
    const stem = w.slice(0, Math.max(4, w.length - 2));   // crude Russian stemming: «ткани» ~ «ткань»
    if (words.some((x) => x.startsWith(stem))) score += 1;
  }
  return score;
}

export type Hit = { kind: "task"; obj: Task } | { kind: "idea"; obj: Idea };

export function search(query: string, tasks: Task[], ideas: Idea[], limit = 10): Hit[] {
  const q = tokens(query);
  if (!q.length) return [];
  const hits: [number, Hit][] = [];
  for (const t of tasks) {
    const s = match(q, t.title) * 3 + match(q, t.description) + match(q, t.stage);
    if (s) hits.push([s + (isDone(t) ? 0 : 1), { kind: "task", obj: t }]);
  }
  for (const i of ideas) {
    const s = match(q, i.title) * 3 + match(q, i.description) + match(q, i.closes);
    if (s) hits.push([s, { kind: "idea", obj: i }]);
  }
  hits.sort((a, b) => b[0] - a[0]);
  return hits.slice(0, limit).map((h) => h[1]);
}

function validDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Accepts 15.11, 15.11.2026, 2026-11-15, «сегодня», «завтра», «+3». */
export function parseDate(text: string, today: string): string | null {
  const s = text.trim().toLowerCase();
  if (s === "сегодня") return today;
  if (s === "завтра") return addDays(today, 1);
  let m = s.match(/^\+(\d{1,3})$/);
  if (m) return addDays(today, Number(m[1]));
  m = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/);
  if (m) {
    const d = Number(m[1]), mo = Number(m[2]);
    if (m[3]) return validDate(Number(m[3]) + (m[3].length === 2 ? 2000 : 0), mo, d);
    const y = Number(today.slice(0, 4));
    const cand = validDate(y, mo, d);
    if (!cand) return null;
    return cand >= addDays(today, -30) ? cand : validDate(y + 1, mo, d);
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}
