// Message renderers (Telegram HTML).
import { addDays, daysBetween, weekdayOf } from "./config.ts";
import * as logic from "./logic.ts";
import { STAGES, isDone } from "./models.ts";
import type { Event, Idea, Member, Milestone, Task } from "./models.ts";
import type { Storage } from "./storage.ts";

export const STATUS_ICON: Record<string, string> = { "Не начато": "⚪", "В работе": "🔵", "На проверке": "🟡", "Готово": "✅" };
const MS_ICON: Record<string, string> = { "Впереди": "◻️", "Достигнута": "✅", "Под угрозой": "⚠️", "Сорвана": "❌" };
export const TYPE_ICON: Record<string, string> = { "Задача": "", "Решение": "⚖️ ", "Риск": "🛡 " };
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
const MAX_LEN = 4000;

export const esc = (s: string): string => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const humanDate = (d: string): string => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
export const shortDate = (d: string | null): string => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "");
const evTime = (ts: string): string => `${ts.slice(8, 10)}.${ts.slice(5, 7)} ${ts.slice(11, 16)}`;

export function cut(text: string, n: number): string {
  const t = (text || "").trim();
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + "…";
}

export const clip = (text: string): string => (text.length <= MAX_LEN ? text : text.slice(0, MAX_LEN - 20).trimEnd() + "\n…");

// Each person has a colour marker; ⚪ — free task, 🔴 — overdue, ✅ — done.
export const PALETTE = ["🟢", "🟣", "🟠", "🔵", "🟡", "🟤", "⚫"];

/** Stable colour per person, kept in kv "colors" so it never changes when someone joins. */
export async function loadColors(st: Storage, members: Member[], notionUsers: { id: string; type?: string }[]): Promise<Record<string, string>> {
  const colors = { ...((await st.kvGet<Record<string, string>>("colors")) || {}) };
  const linked = new Set(members.map((m) => m.notion_user_id).filter(Boolean));
  const keys = [
    ...members.filter((m) => m.approved).map((m) => `tg:${m.tg_id}`),
    ...notionUsers.filter((u) => u.type !== "bot" && !linked.has(u.id)).map((u) => `n:${u.id}`),
  ];
  let changed = false;
  for (const k of keys) {
    if (colors[k]) continue;
    const used = new Set(Object.values(colors));
    colors[k] = PALETTE.find((c) => !used.has(c)) || PALETTE[Object.keys(colors).length % PALETTE.length];
    changed = true;
  }
  if (changed) await st.kvSet("colors", colors);
  return colors;
}

/** Resolves assignees to display names (Telegram member first, then Notion user) and colour markers. */
export class Names {
  members: Map<number, Member>;
  notion: Map<string, string>;
  colors: Record<string, string>;
  byNotion: Map<string, number>;

  constructor(members: Member[], notionUsers: { id: string; name: string }[], colors: Record<string, string> = {}) {
    this.members = new Map(members.map((m) => [m.tg_id, m]));
    this.notion = new Map(notionUsers.map((u) => [u.id, u.name || ""]));
    this.colors = colors;
    this.byNotion = new Map(members.filter((m) => m.notion_user_id).map((m) => [m.notion_user_id!, m.tg_id]));
  }

  static async load(st: Storage): Promise<Names> {
    const members = await st.members();
    const users = await st.notionUsers();
    return new Names(members, users, await loadColors(st, members, users as { id: string; type?: string }[]));
  }

  /** Colour of a person (Telegram id), ⚪ if unknown. */
  colorOf(tgId: number): string { return this.colors[`tg:${tgId}`] || "⚪"; }

  /** ✅ done, 🔴 overdue, ⚪ free, otherwise the assignee's colour. */
  marker(t: Task, today: string): string {
    if (isDone(t)) return "✅";
    if (t.due && t.due < today) return "🔴";
    if (logic.isJoint(t)) return "🤝";
    const tg = t.assignee_tg || (t.assignee_notion ? this.byNotion.get(t.assignee_notion) : undefined);
    if (tg) return this.colors[`tg:${tg}`] || "⚪";
    if (t.assignee_notion) return this.colors[`n:${t.assignee_notion}`] || "⚪";
    return "⚪";
  }

  /** «🟢 Сергей · 🟣 Аня» */
  legend(): string {
    const out: string[] = [];
    for (const m of this.members.values()) if (m.approved && this.colors[`tg:${m.tg_id}`]) out.push(`${this.colors[`tg:${m.tg_id}`]} ${m.name}`);
    for (const [id, name] of this.notion) if (this.colors[`n:${id}`] && name) out.push(`${this.colors[`n:${id}`]} ${name}`);
    return [...out, "🤝 вместе", "⚪ свободна", "🔴 просрочена"].join(" · ");
  }

  of(t: Task): string {
    let lead = "";
    if (t.assignee_tg && this.members.has(t.assignee_tg)) lead = this.members.get(t.assignee_tg)!.name;
    else if (t.assignee_notion) lead = this.notion.get(t.assignee_notion) || "участник Notion";
    if (!lead) return "";
    const co = [
      ...(t.co_tg || []).map((x) => this.members.get(x)?.name).filter(Boolean),
      ...(t.co_notion || []).filter((x) => !this.byNotion.has(x)).map((x) => this.notion.get(x) || "участник Notion"),
    ];
    return [lead, ...new Set(co)].join(" + ");
  }
}

export function dueLabel(t: Task, today: string): string {
  if (!t.due) return "";
  if (isDone(t)) return shortDate(t.due);
  const d = daysBetween(today, t.due);
  if (d < 0) return `⏰ ${shortDate(t.due)}, просрочено ${logic.daysStr(-d)}`;
  if (d === 0) return "сегодня";
  if (d === 1) return "завтра";
  return shortDate(t.due);
}

export function taskLine(t: Task, names: Names, today: string, showWho = true): string {
  const parts = [`${names.marker(t, today)} ${TYPE_ICON[t.type] || ""}${esc(t.title)}`];
  if (t.status === "На проверке") parts.push("на проверке");
  const dl = dueLabel(t, today);
  if (dl) parts.push(dl);
  if (showWho) {
    const who = names.of(t);
    parts.push(who ? esc(who) : "свободна");
  }
  return parts.join(" · ");
}

export function buttonLabel(t: Task, today: string, names?: Names): string {
  let dl = dueLabel(t, today);
  if (dl.startsWith("⏰")) dl = shortDate(t.due);
  const mark = names ? names.marker(t, today) : isDone(t) ? "✅" : t.due && t.due < today ? "🔴" : t.assignee_tg || t.assignee_notion ? STATUS_ICON[t.status] || "⚪" : "⚪";
  const label = `${mark} ${cut(t.title, t.status === "На проверке" ? 30 : 38)}${t.status === "На проверке" ? " · проверка" : ""}`;
  return dl ? `${label} · ${dl}` : label;
}

export async function taskCard(t: Task, st: Storage, today: string, events: Event[]): Promise<string> {
  const names = await Names.load(st);
  const tasks = await st.tasks();
  const byId = new Map(tasks.map((x) => [x.id, x]));
  const ms = new Map((await st.milestones()).map((m) => [m.id, m]));
  const lines = [
    `<b>${TYPE_ICON[t.type] || ""}${esc(t.title)}</b>`,
    `<i>${esc(t.stage || "Без этапа")} · ${esc(t.type)} · приоритет: ${esc(t.priority.toLowerCase())}</i>`,
    "",
    `Статус: ${STATUS_ICON[t.status] || ""} ${esc(t.status)}`,
  ];
  if (t.due) {
    const d = daysBetween(today, t.due);
    const rel = isDone(t) ? "" : d < 0 ? ` — просрочено на ${logic.daysStr(-d)}` : d === 0 ? " — сегодня" : ` — через ${logic.daysStr(d)}`;
    lines.push(`Срок: ${t.start ? shortDate(t.start) + "–" : ""}${shortDate(t.due)}${rel}`);
  }
  const who = names.of(t);
  lines.push(`Исполнитель: ${names.marker(t, today)} ${who ? esc(who) : "свободна — можно взять"}`);
  const ml = t.milestones.filter((i) => ms.has(i)).map((i) => `«${esc(ms.get(i)!.title)}» ${shortDate(ms.get(i)!.date)}`);
  if (ml.length) lines.push("Веха: " + ml.join(", "));
  const deps = t.depends_on.map((d) => byId.get(d)).filter((x): x is Task => !!x);
  if (deps.length) lines.push("Зависит от: " + deps.map((x) => `${isDone(x) ? "✅" : "⏳"} ${esc(cut(x.title, 40))}`).join("; "));
  const blocks = logic.blockedTasks(t, tasks);
  if (blocks.length) lines.push(`Блокирует: ${blocks.length} ${logic.plural(blocks.length, logic.TASKS)}`);
  if (t.result) {
    lines.push(t.result.startsWith("http")
      ? `Результат: <a href="${esc(t.result)}">${esc(cut(t.result, 60))}</a>`
      : `Результат: ${esc(t.result)}`);
  }
  if (t.description) lines.push("", esc(cut(t.description, 700)));
  if (events.length) {
    lines.push("", "<b>История</b>");
    for (const e of events.slice(-5)) lines.push(`<code>${evTime(e.ts)}</code> ${esc(e.actor)}: ${esc(cut(e.text, 120))}`);
  }
  if (t.dirty.length && t.id.startsWith("local-") && !t.notion_id) lines.push("", "<i>Появится в Notion после ближайшей синхронизации.</i>");
  return clip(lines.join("\n"));
}

export function history(t: Task, events: Event[]): string {
  const lines = [`<b>История: ${esc(t.title)}</b>`, ""];
  if (!events.length) lines.push("Пока пусто.");
  for (const e of events.slice(-40)) lines.push(`<code>${evTime(e.ts)}</code> ${esc(e.actor)}: ${esc(e.text)}`);
  if (t.log && !events.length) lines.push("", "<b>Журнал из Notion</b>", esc(cut(t.log, 2500)));
  return clip(lines.join("\n"));
}

export function milestoneLine(m: Milestone, tasks: Task[], today: string): string {
  const linked = logic.milestoneTasks(m, tasks);
  const done = linked.filter(isDone).length;
  const pct = linked.length ? Math.round((100 * done) / linked.length) : 0;
  let when = "";
  if (m.date) {
    const d = daysBetween(today, m.date);
    when = shortDate(m.date) + (d > 0 ? `, через ${logic.daysStr(d)}` : d === 0 ? ", сегодня" : "");
  }
  return `${MS_ICON[m.status] || "◻️"} <b>${esc(m.title)}</b> — ${when}\n    ${logic.bar(pct, 10)} ${done}/${linked.length}`;
}

export async function headerStats(st: Storage, today: string): Promise<string[]> {
  const tasks = await st.tasks();
  const [done, total, pct] = logic.progress(tasks);
  const days = logic.daysToLaunch(await st.milestones(), today);
  const s = logic.streak(await st.days(), today);
  const lines: string[] = [];
  if (days > 0) lines.push(`🚀 До запуска продаж: <b>${logic.daysStr(days)}</b>`);
  lines.push(`Прогресс: ${logic.bar(pct)} <b>${pct}%</b> (${done}/${total})`);
  lines.push(`Серия без просрочек: <b>${logic.daysStr(s)}</b>`);
  return lines;
}

export async function teamDigest(st: Storage, today: string, title = "Сводка"): Promise<string> {
  const tasks = await st.tasks();
  const milestones = await st.milestones();
  const names = await Names.load(st);
  const lines = [`<b>TheBearLab · ${title} на ${humanDate(today)}, ${WEEKDAYS[weekdayOf(today)]}</b>`, "", ...(await headerStats(st, today))];
  const od = logic.overdue(tasks, today);
  if (od.length) {
    lines.push("", `<b>⏰ Просрочено (${od.length})</b>`, ...od.slice(0, 8).map((t) => taskLine(t, names, today)));
    if (od.length > 8) lines.push(`…и ещё ${od.length - 8}`);
  }
  const td = logic.dueOn(tasks, today);
  if (td.length) lines.push("", `<b>📅 Срок сегодня (${td.length})</b>`, ...td.slice(0, 8).map((t) => taskLine(t, names, today)));
  const soon = logic.dueWithin(tasks, addDays(today, 1), 2);
  if (soon.length) lines.push("", "<b>Ближайшие 3 дня</b>", ...soon.slice(0, 6).map((t) => taskLine(t, names, today)));
  const nm = logic.nextMilestone(milestones, today);
  if (nm) lines.push("", "<b>🎯 Ближайшая веха</b>", milestoneLine(nm, tasks, today));
  const free = logic.suggest(tasks, milestones, null, today, 4);
  if (free.length) {
    lines.push("", "<b>🙋 Можно взять</b>");
    for (const s of free) lines.push(`• ${esc(s.task.title)}${s.reasons.length ? " — " + esc(s.reasons.slice(0, 2).join(", ")) : ""}`);
  }
  return clip(lines.join("\n"));
}

export async function personal(st: Storage, m: Member, today: string, evening = false): Promise<string | null> {
  const tasks = await st.tasks();
  const names = await Names.load(st);
  const mine = tasks.filter((t) => logic.isMine(t, m.tg_id) && !isDone(t));
  const od = logic.overdue(mine, today);
  const td = logic.dueOn(mine, today);
  const tomorrow = logic.dueOn(mine, addDays(today, 1));
  const soon = mine.filter((t) => t.due && t.due > addDays(today, 1) && t.due <= addDays(today, 3));
  const work = mine.filter((t) => t.status === "В работе" && !od.includes(t) && !td.includes(t) && !tomorrow.includes(t));
  const lines: string[] = [];
  if (evening) {
    if (!od.length && !td.length && !tomorrow.length) return null;
    lines.push(`<b>${esc(m.name)}, вечерняя сверка</b>`);
    if (td.length) lines.push("", "Срок сегодня — отметь результат или перенеси:", ...td.map((t) => taskLine(t, names, today, false)));
    if (tomorrow.length) lines.push("", "<b>🔔 Завтра срок</b> — успеваешь? Если нет, перенеси заранее:", ...tomorrow.map((t) => taskLine(t, names, today, false)));
    if (od.length) lines.push("", "Просрочено:", ...od.map((t) => taskLine(t, names, today, false)));
    return lines.join("\n");
  }
  lines.push(`<b>Доброе утро, ${esc(m.name)}!</b>`);
  const s = logic.streak(await st.days(), today, String(m.tg_id));
  if (s) lines.push(`Твоя серия без просрочек: ${logic.daysStr(s)}`);
  if (od.length) lines.push("", "<b>⏰ Просрочено</b>", ...od.map((t) => taskLine(t, names, today, false)));
  if (td.length) lines.push("", "<b>📅 Сегодня</b>", ...td.map((t) => taskLine(t, names, today, false)));
  if (tomorrow.length) lines.push("", "<b>🔔 Завтра срок</b>", ...tomorrow.map((t) => taskLine(t, names, today, false)));
  if (soon.length) lines.push("", "<b>🗓 Скоро срок</b>", ...soon.map((t) => taskLine(t, names, today, false)));
  if (work.length) lines.push("", "<b>🔵 В работе</b>", ...work.filter((t) => !soon.includes(t)).slice(0, 6).map((t) => taskLine(t, names, today, false)));
  const sug = logic.suggest(tasks, await st.milestones(), m.tg_id, today, 1);
  if (sug.length) {
    lines.push("", `<b>Совет дня:</b> ${esc(sug[0].task.title)}`);
    if (sug[0].reasons.length) lines.push(`<i>${esc(sug[0].reasons.join(", "))}</i>`);
  }
  if (lines.length === 1) lines.push("Задач на тебе нет — загляни в /free.");
  return lines.join("\n");
}

export async function weekly(st: Storage, today: string): Promise<string> {
  const tasks = await st.tasks();
  const byId = new Map((await st.tasks(true)).map((t) => [t.id, t]));
  const names = await Names.load(st);
  const start = addDays(today, -6);
  const evs = await st.events(start);
  const doneIds: string[] = [];
  const perActor = new Map<string, number>();
  for (const e of evs) {
    if (e.kind === "done" && !doneIds.includes(e.task_id)) {
      doneIds.push(e.task_id);
      perActor.set(e.actor, (perActor.get(e.actor) || 0) + 1);
    }
  }
  const lines = [`<b>TheBearLab · итоги недели (${shortDate(start)}–${shortDate(today)})</b>`, "", ...(await headerStats(st, today))];
  lines.push("", `<b>✅ Закрыто за неделю: ${doneIds.length}</b>`);
  for (const i of doneIds.slice(0, 12)) if (byId.has(i)) lines.push(`• ${esc(byId.get(i)!.title)}`);
  if (perActor.size) lines.push("Кто закрывал: " + [...perActor.entries()].sort((a, b) => b[1] - a[1]).map(([a, n]) => `${esc(a)} — ${n}`).join(", "));
  const od = logic.overdue(tasks, today);
  if (od.length) lines.push("", `<b>⏰ Просрочено (${od.length})</b>`, ...od.slice(0, 8).map((t) => taskLine(t, names, today)));
  const nxt = logic.dueWithin(tasks, addDays(today, 1), 7);
  if (nxt.length) lines.push("", "<b>📅 Сроки на следующей неделе</b>", ...nxt.slice(0, 10).map((t) => taskLine(t, names, today)));
  lines.push("", "<b>Вехи</b>");
  for (const m of await st.milestones()) {
    if (m.status !== "Достигнута" || (m.date && m.date >= addDays(today, -7))) lines.push(milestoneLine(m, tasks, today));
  }
  return clip(lines.join("\n"));
}

export async function plan(st: Storage, today: string): Promise<string> {
  const tasks = await st.tasks();
  const lines = ["<b>Роадмап TheBearLab</b>", "", ...(await headerStats(st, today)), "", "<b>Вехи</b>"];
  for (const m of await st.milestones()) lines.push(milestoneLine(m, tasks, today));
  lines.push("", "<b>Этапы</b>");
  for (const s of STAGES) {
    const ts = tasks.filter((t) => t.stage === s);
    if (!ts.length) continue;
    const [d, n, p] = logic.progress(ts);
    lines.push(`${esc(s)}\n    ${logic.bar(p, 10)} ${d}/${n}`);
  }
  return clip(lines.join("\n"));
}

export function ideaCard(i: Idea): string {
  const lines = [`<b>💡 ${esc(i.title)}</b>`, `<i>${esc(i.group)} · очередь: ${esc(i.queue || "—")} · ${esc(i.status)}</i>`];
  if (i.description) lines.push("", esc(cut(i.description, 1200)));
  if (i.closes) lines.push("", `<b>Что закрывает:</b> ${esc(cut(i.closes, 500))}`);
  return clip(lines.join("\n"));
}

export const HELP = `<b>the Bear Lab Bot</b> — штурман по роадмапу запуска TheBearLab.

/today — сводка: прогресс, просрочки, сроки, ближайшая веха
/my — мой кабинет: мои задачи по срокам и мои напоминания
/settings — какие уведомления присылать тебе
/board — живая доска в личке: прогресс и твои задачи, отмечай ✓ прямо в ней
/next — что делать дальше (с объяснением почему)
/free — свободные задачи, которые можно взять
/tasks — задачи по этапам
/plan — роадмап: вехи и этапы
/milestones — вехи
/ideas — бэклог идей → превращаются в задачи
/new — новая задача
/ask вопрос — спросить ИИ-консультанта (в личке можно просто писать своими словами или голосом)
/find текст — поиск по задачам и идеям
/team — команда и привязка к Notion
/memory — память команды: решения, выводы, договорённости
/sync — синхронизировать с Notion сейчас

В карточке задачи: взять / снять с себя / назначить / 🤝 делать вместе (несколько исполнителей, как в Notion), статус, перенос срока, результат (ссылка), заметка в журнал, история.
Все изменения видны команде и попадают в Notion (поле «Журнал»).
Когда задача попадает на тебя (взял сам — в чате, голосом или через ИИ — или тебе назначили), карточка приходит в личку; бот напоминает о сроке накануне вечером и утром в день срока.
Маркеры задач: цвет исполнителя, 🤝 — делаем вместе, ⚪ — свободна, 🔴 — просрочена, ✅ — готово.
Напоминания: «Бро, напомни Ане в четверг в 10 про образцы».
Каждый вечер в 19:00 — чек-ин «что сегодня продвинулось?»: ответь текстом или голосом, бот разнесёт по журналам задач.
В понедельник — план недели с кнопками, в пятницу — итоги с графиком прогресса.
В общем чате: /bindchat — сделать его чатом для сводок, /pin — закрепить живую сводку (нужны права админа); /channel — канал с историей работы: лента действий и дневник дня; чтобы спросить бота, начни сообщение с «Бро» («Бро, что горит?»), упомяни его или ответь на его сообщение.`;
