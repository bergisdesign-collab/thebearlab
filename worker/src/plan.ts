// Monday plan: a proposal of who takes what this week (and by when); the team confirms with buttons.
// The AI proposes when it is connected; otherwise a simple heuristic (priority/deadline/milestone
// score from logic.suggest, then the least loaded person).
import { addDays } from "./config.ts";
import type { Btn, Notice } from "./app.ts";
import * as logic from "./logic.ts";
import { isDone } from "./models.ts";
import type { Member, Task } from "./models.ts";
import type { Storage } from "./storage.ts";
import { esc, shortDate } from "./texts.ts";

export interface PlanItem { t: string; who: number; due: string | null; why: string; state?: "ok" | "no" }
export interface WeekPlan { date: string; items: PlanItem[] }

export interface PlanInput { tasks: Task[]; members: Member[]; load: Map<number, number>; candidates: Task[] }

export async function planInput(st: Storage, today: string): Promise<PlanInput> {
  const tasks = await st.tasks();
  const members = (await st.members()).filter((m) => m.approved);
  const load = new Map(members.map((m) => [m.tg_id, tasks.filter((t) => t.assignee_tg === m.tg_id && !isDone(t)).length]));
  const free = logic.suggest(tasks, await st.milestones(), null, today, 12).map((s) => s.task).filter((t) => !t.assignee_tg && !t.assignee_notion);
  // also my own tasks without a date — they get a date proposal
  const undated = tasks.filter((t) => t.assignee_tg && !isDone(t) && !t.due && t.status !== "На проверке").slice(0, 4);
  return { tasks, members, load, candidates: [...free.slice(0, 8), ...undated] };
}

export function heuristicPlan(inp: PlanInput, today: string): PlanItem[] {
  const load = new Map(inp.load);
  const out: PlanItem[] = [];
  for (const t of inp.candidates.slice(0, 8)) {
    let who = t.assignee_tg;
    if (!who) {
      const best = [...load.entries()].sort((a, b) => a[1] - b[1])[0];
      if (!best) break;
      who = best[0];
      load.set(who, best[1] + 1);
    }
    const due = t.due || addDays(today, t.priority === "Высокий" ? 4 : 7);
    out.push({ t: t.id, who, due, why: t.assignee_tg ? "нет срока" : `меньше всего задач (${load.get(who)! - 1})` });
  }
  return out;
}

export function planNotice(plan: WeekPlan, tasks: Map<string, Task>, names: Map<number, string>, chatId: number): Notice {
  const lines = [`🗓 <b>План недели</b> — предложение на ${shortDate(plan.date)}–${shortDate(addDays(plan.date, 6))}`, "Подтвердите кнопками: ✅ — принять пункт, ✖ — пропустить.", ""];
  const kb: Btn[][] = [];
  plan.items.forEach((it, i) => {
    const t = tasks.get(it.t);
    if (!t) return;
    const mark = it.state === "ok" ? "✅" : it.state === "no" ? "✖" : `${i + 1}.`;
    lines.push(`${mark} <b>${esc(names.get(it.who) || "?")}</b> — ${esc(t.title)}${it.due ? ` · до ${shortDate(it.due)}` : ""}${it.why ? `\n    <i>${esc(it.why)}</i>` : ""}`);
    if (!it.state) kb.push([{ text: `✅ ${i + 1}`, data: `pl:ok:${i}` }, { text: `✖ ${i + 1}`, data: `pl:no:${i}` }, { text: `${t.title}`.slice(0, 28), data: `t:v:${t.id}` }]);
  });
  if (plan.items.some((x) => !x.state)) kb.push([{ text: "✅ Принять всё", data: "pl:all" }]);
  else lines.push("", "План разобран 👍");
  return { chatId, text: lines.join("\n"), kb };
}
