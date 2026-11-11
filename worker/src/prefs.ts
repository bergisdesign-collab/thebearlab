// Per-person notification settings and team-wide (group) settings.
import type { Storage } from "./storage.ts";

export interface Prefs {
  morning: boolean;   // personal morning plan in private chat
  evening: boolean;   // evening reminder: today, overdue, tomorrow's deadlines
  checkin: boolean;   // evening check-in «что сегодня продвинулось?»
  cabinet: boolean;   // a card in private chat when a task lands in my cabinet
  window: boolean;    // «one window» in private chat
}

export const PREF_LABELS: [keyof Prefs, string][] = [
  ["morning", "Утренний план в личку (09:00)"],
  ["evening", "Вечерние напоминания о сроках (18:00)"],
  ["checkin", "Вечерний чек-ин «что продвинулось?» (19:00)"],
  ["cabinet", "Карточка в личку, когда задача попадает ко мне"],
  ["window", "Одно окно в личке"],
];

const DEFAULTS: Prefs = { morning: true, evening: true, checkin: true, cabinet: true, window: true };

export async function getPrefs(st: Storage, tgId: number): Promise<Prefs> {
  return { ...DEFAULTS, ...((await st.kvGet<Partial<Prefs>>(`prefs:${tgId}`)) || {}) };
}

export async function togglePref(st: Storage, tgId: number, key: keyof Prefs): Promise<Prefs> {
  const p = await getPrefs(st, tgId);
  p[key] = !p[key];
  await st.kvSet(`prefs:${tgId}`, p);
  return p;
}

export interface GroupPrefs {
  digest: boolean;    // morning digest + evening line + Friday report in the group
  pinned: boolean;    // pinned live summary in the group
  monday: boolean;    // Monday plan proposal in the group
  feed: boolean;      // live feed of actions in the history channel
  diary: boolean;     // daily diary in the history channel
}

export const GROUP_LABELS: [keyof GroupPrefs, string][] = [
  ["digest", "Сводки и итоги в общем чате"],
  ["pinned", "Закреплённая живая сводка"],
  ["monday", "План недели по понедельникам"],
  ["feed", "Лента действий в канале"],
  ["diary", "Дневник дня в канале (21:00)"],
];

const GROUP_DEFAULTS: GroupPrefs = { digest: true, pinned: true, monday: true, feed: true, diary: true };

export async function getGroupPrefs(st: Storage): Promise<GroupPrefs> {
  return { ...GROUP_DEFAULTS, ...((await st.kvGet<Partial<GroupPrefs>>("group_prefs")) || {}) };
}

export async function toggleGroupPref(st: Storage, key: keyof GroupPrefs): Promise<GroupPrefs> {
  const p = await getGroupPrefs(st);
  p[key] = !p[key];
  await st.kvSet("group_prefs", p);
  return p;
}
