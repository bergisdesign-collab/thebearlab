// Rich-message versions (Telegram Bot API 10.1+, Markdown) of the main screens: headings, tables,
// collapsible history. The plain-HTML versions in texts.ts stay as the fallback.
import { addDays, daysBetween, weekdayOf } from "./config.ts";
import * as logic from "./logic.ts";
import { STAGES, isDone } from "./models.ts";
import type { Event, Milestone, Task } from "./models.ts";
import type { Storage } from "./storage.ts";
import { Names, STATUS_ICON, TYPE_ICON, humanDate, shortDate } from "./texts.ts";

const WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
const MS_ICON: Record<string, string> = { "Впереди": "◻️", "Достигнута": "✅", "Под угрозой": "⚠️", "Сорвана": "❌" };

/** Escape text so that Markdown does not interpret it. */
export const md = (s: string): string => (s || "").replace(/([\\`*_~|[\]()#>=<!+])/g, "\\$1").replace(/\n+/g, " ");

const cell = (s: string, n = 48): string => {
  const t = (s || "").trim();
  return md(t.length > n ? t.slice(0, n - 1) + "…" : t);
};

function dueCell(t: Task, today: string): string {
  if (!t.due) return "—";
  if (isDone(t)) return shortDate(t.due);
  const d = daysBetween(today, t.due);
  if (d < 0) return `⏰ ${shortDate(t.due)} (−${d * -1} дн.)`;
  if (d === 0) return "сегодня";
  if (d === 1) return "завтра";
  return shortDate(t.due);
}

function taskTable(tasks: Task[], names: Names, today: string, withWho = true): string {
  const head = withWho ? "| Задача | Срок | Кто |\n|:--|:--:|:--|" : "| Задача | Срок |\n|:--|:--:|";
  const rows = tasks.map((t) => `| ${STATUS_ICON[t.status] || "⚪"} ${cell(t.title)} | ${dueCell(t, today)} |${withWho ? ` ${cell(names.of(t) || "свободна", 16)} |` : ""}`);
  return [head, ...rows].join("\n");
}

function msLine(m: Milestone, tasks: Task[], today: string): string {
  const linked = logic.milestoneTasks(m, tasks);
  const done = linked.filter(isDone).length;
  const d = m.date ? daysBetween(today, m.date) : null;
  const when = m.date ? `${shortDate(m.date)}${d !== null && d > 0 ? `, через ${logic.daysStr(d)}` : d === 0 ? ", сегодня" : ""}` : "без даты";
  return `${MS_ICON[m.status] || "◻️"} **${md(m.title)}** — ${when} · готово ${done}/${linked.length}`;
}

async function header(st: Storage, today: string): Promise<string> {
  const tasks = await st.tasks();
  const [done, total, pct] = logic.progress(tasks);
  const days = logic.daysToLaunch(await st.milestones(), today);
  const s = logic.streak(await st.days(), today);
  return [
    days > 0 ? `🚀 До запуска продаж: **${logic.daysStr(days)}**` : "",
    `Прогресс: ${logic.bar(pct)} **${pct}%** (${done}/${total})`,
    `Серия без просрочек: **${logic.daysStr(s)}**`,
  ].filter(Boolean).join("\n\n");
}

export async function digest(st: Storage, today: string, title = "Сводка"): Promise<string> {
  const tasks = await st.tasks();
  const milestones = await st.milestones();
  const names = await Names.load(st);
  const parts = [`### TheBearLab · ${title} на ${humanDate(today)}, ${WEEKDAYS[weekdayOf(today)]}`, await header(st, today)];
  const od = logic.overdue(tasks, today);
  if (od.length) parts.push(`#### ⏰ Просрочено (${od.length})`, taskTable(od.slice(0, 10), names, today));
  const soon = logic.dueWithin(tasks, today, 3);
  if (soon.length) parts.push("#### 📅 Сегодня и ближайшие 3 дня", taskTable(soon.slice(0, 10), names, today));
  const nm = logic.nextMilestone(milestones, today);
  if (nm) parts.push("#### 🎯 Ближайшая веха", msLine(nm, tasks, today));
  const free = logic.suggest(tasks, milestones, null, today, 4);
  if (free.length) parts.push("#### 🙋 Можно взять", free.map((s) => `- ${md(s.task.title)}${s.reasons.length ? ` — _${md(s.reasons.slice(0, 2).join(", "))}_` : ""}`).join("\n"));
  return parts.join("\n\n");
}

export async function plan(st: Storage, today: string): Promise<string> {
  const tasks = await st.tasks();
  const parts = ["### Роадмап TheBearLab", await header(st, today), "#### Вехи",
    "| Веха | Дата | Статус | Готово |\n|:--|:--:|:--|:--:|\n" + (await st.milestones()).map((m) => {
      const linked = logic.milestoneTasks(m, tasks);
      return `| ${cell(m.title, 40)} | ${shortDate(m.date) || "—"} | ${MS_ICON[m.status] || ""} ${md(m.status)} | ${linked.filter(isDone).length}/${linked.length} |`;
    }).join("\n"),
    "#### Этапы",
    "| Этап | Прогресс | Готово |\n|:--|:--|:--:|\n" + STAGES.map((s) => {
      const [d, n, p] = logic.progress(tasks.filter((t) => t.stage === s));
      return n ? `| ${md(s)} | ${logic.bar(p, 8)} ${p}% | ${d}/${n} |` : "";
    }).filter(Boolean).join("\n"),
  ];
  return parts.join("\n\n");
}

export async function milestones(st: Storage, today: string): Promise<string> {
  const tasks = await st.tasks();
  return ["### Вехи", ...(await st.milestones()).map((m) => msLine(m, tasks, today))].join("\n\n");
}

export async function taskCard(t: Task, st: Storage, today: string, events: Event[]): Promise<string> {
  const names = await Names.load(st);
  const tasks = await st.tasks();
  const byId = new Map(tasks.map((x) => [x.id, x]));
  const ms = new Map((await st.milestones()).map((m) => [m.id, m]));
  const facts: string[] = [`- **Статус:** ${STATUS_ICON[t.status] || ""} ${md(t.status)}`];
  if (t.due) {
    const d = daysBetween(today, t.due);
    const rel = isDone(t) ? "" : d < 0 ? ` — просрочено на ${logic.daysStr(-d)}` : d === 0 ? " — сегодня" : ` — через ${logic.daysStr(d)}`;
    facts.push(`- **Срок:** ${t.start ? shortDate(t.start) + "–" : ""}${shortDate(t.due)}${rel}`);
  }
  const who = names.of(t);
  facts.push(`- **Исполнитель:** ${who ? md(who) : "свободна — можно взять"}`);
  facts.push(`- **Этап:** ${md(t.stage || "без этапа")} · ${md(t.type)} · приоритет ${md(t.priority.toLowerCase())}`);
  const ml = t.milestones.filter((i) => ms.has(i)).map((i) => `${md(ms.get(i)!.title)} (${shortDate(ms.get(i)!.date)})`);
  if (ml.length) facts.push(`- **Веха:** ${ml.join(", ")}`);
  const deps = t.depends_on.map((d) => byId.get(d)).filter((x): x is Task => !!x);
  if (deps.length) facts.push(`- **Зависит от:** ${deps.map((x) => `${isDone(x) ? "✅" : "⏳"} ${cell(x.title, 40)}`).join("; ")}`);
  const blocks = logic.blockedTasks(t, tasks);
  if (blocks.length) facts.push(`- **Блокирует:** ${blocks.length} ${logic.plural(blocks.length, logic.TASKS)}`);
  if (t.result) facts.push(`- **Результат:** ${t.result.startsWith("http") ? `[${cell(t.result, 50)}](${t.result.replace(/\)/g, "%29")})` : md(t.result)}`);
  const parts = [`### ${TYPE_ICON[t.type] || ""}${md(t.title)}`, facts.join("\n")];
  if (t.description) parts.push(md(t.description.slice(0, 1200)));
  if (events.length) {
    parts.push(`<details><summary>История (${events.length})</summary>\n\n${events.slice(-15).map((e) => `- ${e.ts.slice(8, 10)}.${e.ts.slice(5, 7)} ${e.ts.slice(11, 16)} **${md(e.actor)}**: ${md(e.text)}`).join("\n")}\n\n</details>`);
  }
  if (t.dirty.length && t.id.startsWith("local-") && !t.notion_id) parts.push("_Появится в Notion после ближайшей синхронизации._");
  return parts.join("\n\n");
}

export async function weekly(st: Storage, today: string): Promise<string> {
  const tasks = await st.tasks();
  const byId = new Map((await st.tasks(true)).map((t) => [t.id, t]));
  const names = await Names.load(st);
  const start = addDays(today, -6);
  const doneIds: string[] = [];
  const perActor = new Map<string, number>();
  for (const e of await st.events(start)) {
    if (e.kind === "done" && !doneIds.includes(e.task_id)) {
      doneIds.push(e.task_id);
      perActor.set(e.actor, (perActor.get(e.actor) || 0) + 1);
    }
  }
  const parts = [`### TheBearLab · итоги недели ${shortDate(start)}–${shortDate(today)}`, await header(st, today),
    `#### ✅ Закрыто за неделю: ${doneIds.length}`];
  if (doneIds.length) parts.push(doneIds.slice(0, 12).filter((i) => byId.has(i)).map((i) => `- ${md(byId.get(i)!.title)}`).join("\n"));
  if (perActor.size) parts.push("Кто закрывал: " + [...perActor.entries()].sort((a, b) => b[1] - a[1]).map(([a, n]) => `**${md(a)}** — ${n}`).join(", "));
  const od = logic.overdue(tasks, today);
  if (od.length) parts.push(`#### ⏰ Просрочено (${od.length})`, taskTable(od.slice(0, 10), names, today));
  const nxt = logic.dueWithin(tasks, addDays(today, 1), 7);
  if (nxt.length) parts.push("#### 📅 Сроки на следующей неделе", taskTable(nxt.slice(0, 12), names, today));
  parts.push("#### Вехи", (await st.milestones()).filter((m) => m.status !== "Достигнута" || (m.date && m.date >= addDays(today, -7))).map((m) => msLine(m, tasks, today)).join("\n\n"));
  return parts.join("\n\n");
}
