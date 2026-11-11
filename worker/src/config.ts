// Settings and time helpers. Secrets come from Worker secrets (env), never from the repo.

export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface D1Like {
  prepare(query: string): D1Stmt;
}

export interface Env {
  DB: D1Like;
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  CRON_SECRET?: string;
  NOTION_TOKEN?: string;
  ADMIN_IDS?: string;
  ANTHROPIC_API_KEY?: string;   // AI consultant (Haiku) + weekly review (Opus)
  OPENAI_API_KEY?: string;      // voice messages → text (fallback; Workers AI is used by default)
  AI?: { run(model: string, input: Record<string, unknown>): Promise<any> };   // Workers AI binding
  BOT_USERNAME?: string;
}

export const BOT_NAME = "the Bear Lab Bot";
export const LAUNCH_DATE = "2027-02-05";
export const LAUNCH_MILESTONE = "Запуск продаж";
// New-year break: no deadlines, no reminders, streak is not broken.
export const HOLIDAY_START = "2027-01-01";
export const HOLIDAY_END = "2027-01-11";

export const NOTION_TASKS_DB = "68024e36533543438e3ba32e71a2b314";
export const NOTION_MILESTONES_DB = "505ce45d15a446ab9fe86649958dd598";
export const NOTION_IDEAS_DB = "ad2d8120e9404cc099eb400aeeaef8d2";
export const NOTION_MEMORY_DB = "c4aa5c698c3a40c6aef494856a6d20f3";

// Scheduled jobs, Moscow time. A job fires on the first tick in [time, time + 2h).
export const JOBS: Record<string, { hour: number; minute: number; weekday: number | null }> = {
  morning: { hour: 9, minute: 0, weekday: null },
  evening: { hour: 18, minute: 0, weekday: null },
  weekly: { hour: 18, minute: 0, weekday: 4 },   // Friday (Mon = 0)
};

/** ADMIN_IDS: Telegram ids and/or @usernames, separated by ; , or spaces (e.g. "123456789;@anya"). */
export function adminIds(env: Pick<Env, "ADMIN_IDS">): Set<string> {
  return new Set((env.ADMIN_IDS || "").split(/[,; ]+/).map((x) => x.trim().replace(/^@/, "").toLowerCase()).filter(Boolean));
}

export function isAdminListed(admins: Set<string>, id: number, username?: string): boolean {
  return admins.has(String(id)) || (!!username && admins.has(username.toLowerCase()));
}

export type Clock = () => Date;
export const realClock: Clock = () => new Date();

const MSK_OFFSET = 3 * 3600 * 1000;   // Moscow, no DST

export interface MskTime { date: string; hour: number; minute: number; weekday: number; iso: string }

export function msk(d: Date): MskTime {
  const m = new Date(d.getTime() + MSK_OFFSET);
  const s = m.toISOString();
  return {
    date: s.slice(0, 10),
    hour: m.getUTCHours(),
    minute: m.getUTCMinutes(),
    weekday: (m.getUTCDay() + 6) % 7,
    iso: s.slice(0, 19) + "+03:00",
  };
}

export function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

/** b − a in days. */
export function daysBetween(a: string, b: string): number {
  const pa = a.split("-").map(Number);
  const pb = b.split("-").map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

export function weekdayOf(date: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;
}

export const notionUrl = (id: string): string => "https://www.notion.so/" + id.replace(/-/g, "");
