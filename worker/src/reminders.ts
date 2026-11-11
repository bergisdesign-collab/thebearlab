// Personal reminders («Бро, напомни Ане в четверг в 10 про образцы»).
// Stored in D1 (kind "reminder"); every cron tick sends the due ones to the person's private chat.
import { msk } from "./config.ts";
import type { Clock } from "./config.ts";
import type { Notice } from "./app.ts";
import type { Storage } from "./storage.ts";
import { esc } from "./texts.ts";

export interface Reminder {
  id: string;
  tg: number;          // who gets it
  at: string;          // YYYY-MM-DDTHH:MM, Moscow time
  text: string;
  by: string;          // who asked
  task?: string;       // task id, optional
}

/** "2026-11-12T10:00" (MSK) → Date. */
export function mskToDate(at: string): Date {
  return new Date(Date.parse(at.slice(0, 16) + ":00+03:00"));
}

export async function addReminder(st: Storage, clock: Clock, r: Omit<Reminder, "id">): Promise<Reminder> {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r.at)) throw new Error("Время нужно в формате YYYY-MM-DDTHH:MM");
  if (Number.isNaN(mskToDate(r.at).getTime())) throw new Error("Неверная дата");
  if (mskToDate(r.at).getTime() < clock().getTime() - 60_000) throw new Error("Это время уже прошло");
  const mine = (await st.all<Reminder>("reminder")).filter((x) => x.tg === r.tg);
  if (mine.length >= 30) throw new Error("Слишком много напоминаний у этого человека (30)");
  const full: Reminder = { ...r, text: r.text.slice(0, 500), id: clock().getTime().toString(36) + Math.random().toString(36).slice(2, 6) };
  await st.put("reminder", full.id, full);
  return full;
}

export async function cancelReminder(st: Storage, id: string): Promise<boolean> {
  if (!(await st.get("reminder", id))) return false;
  await st.delete("reminder", id);
  return true;
}

/** Due reminders as notices; they are deleted once taken. */
export async function takeDueReminders(st: Storage, clock: Clock): Promise<Notice[]> {
  const now = clock().getTime();
  const out: Notice[] = [];
  for (const r of await st.all<Reminder>("reminder")) {
    if (mskToDate(r.at).getTime() > now) continue;
    await st.delete("reminder", r.id);
    const kb = r.task ? [[{ text: "Открыть задачу", data: `t:v:${r.task}` }]] : [];
    out.push({ chatId: r.tg, text: `⏰ <b>Напоминание</b>${r.by ? ` от ${esc(r.by)}` : ""}\n${esc(r.text)}`, kb });
  }
  return out;
}

export function fmtAt(at: string): string {
  return `${at.slice(8, 10)}.${at.slice(5, 7)} в ${at.slice(11, 16)}`;
}

export function nowMsk(clock: Clock): string {
  return msk(clock()).iso.slice(0, 16);
}
