// Task actions. Every change: updates the task, writes an Event (history), appends a line to the
// task's «Журнал» and marks changed fields dirty so the sync pushes them to Notion.
import { msk } from "./config.ts";
import type { Clock } from "./config.ts";
import { addDays } from "./config.ts";
import * as logic from "./logic.ts";
import { DONE, STATUSES, addDirty, markTask, newTask } from "./models.ts";
import type { Event, Idea, Member, Task } from "./models.ts";
import type { Storage } from "./storage.ts";

const LOG_LIMIT = 1900;

export class ActionError extends Error {}

const fmt = (d: string | null): string => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "—");

export class Service {
  st: Storage;
  clock: Clock;
  recent: Event[] = [];   // events produced since the caller last cleared it

  constructor(st: Storage, clock: Clock) {
    this.st = st;
    this.clock = clock;
  }

  today(): string { return msk(this.clock()).date; }

  // --- history ----------------------------------------------------------------
  private async log(t: Task, actor: Member, kind: string, text: string): Promise<Event> {
    const now = msk(this.clock());
    const ev: Event = { id: crypto.randomUUID().replace(/-/g, ""), ts: now.iso, task_id: t.id, actor: actor.name, kind, text };
    await this.st.addEvent(ev);
    this.recent.push(ev);
    const line = `${now.date.slice(8, 10)}.${now.date.slice(5, 7)} ${now.iso.slice(11, 16)} ${actor.name}: ${text}`;
    let log = t.log ? `${t.log}\n${line}`.trim() : line;
    if (log.length > LOG_LIMIT) {
      log = log.slice(-LOG_LIMIT);
      const nl = log.indexOf("\n");
      if (nl >= 0) log = log.slice(nl + 1);
    }
    t.log = log;
    markTask(t, "log");
    return ev;
  }

  private async save(t: Task): Promise<Task> {
    await this.st.saveTask(t);
    return t;
  }

  // --- assignment ---------------------------------------------------------------
  async take(t: Task, m: Member): Promise<Task> {
    if (t.status === DONE) throw new ActionError("Задача уже выполнена");
    if (t.assignee_tg === m.tg_id) throw new ActionError("Задача уже у тебя");
    if (t.assignee_tg) {
      const owner = await this.st.member(t.assignee_tg);
      throw new ActionError(`Задачу ведёт ${owner ? owner.name : "другой участник"}`);
    }
    t.assignee_tg = m.tg_id;
    t.assignee_notion = m.notion_user_id;
    markTask(t, "assignee_notion");
    if (t.status === "Не начато") { t.status = "В работе"; markTask(t, "status"); }
    await this.log(t, m, "take", "взята в работу");
    return this.save(t);
  }

  async release(t: Task, m: Member): Promise<Task> {
    if (t.assignee_tg !== m.tg_id && !m.admin) throw new ActionError("Снять с себя можно только свою задачу");
    const prev = t.assignee_tg ? await this.st.member(t.assignee_tg) : null;
    t.assignee_tg = null;
    t.assignee_notion = null;
    markTask(t, "assignee_notion");
    if (t.status === "В работе") { t.status = "Не начато"; markTask(t, "status"); }
    const who = !prev || prev.tg_id === m.tg_id ? "" : ` (была у ${prev.name})`;
    await this.log(t, m, "release", "задача освобождена" + who);
    return this.save(t);
  }

  async assign(t: Task, actor: Member, target: Member): Promise<Task> {
    if (t.assignee_tg === target.tg_id) throw new ActionError(`Уже назначена на ${target.name}`);
    t.assignee_tg = target.tg_id;
    t.assignee_notion = target.notion_user_id;
    markTask(t, "assignee_notion");
    await this.log(t, actor, "assign", `назначена на ${target.name}`);
    return this.save(t);
  }

  // --- status / dates / results -------------------------------------------------
  async setStatus(t: Task, actor: Member, status: string): Promise<Task> {
    if (!STATUSES.includes(status)) throw new ActionError("Неизвестный статус");
    if (status === t.status) throw new ActionError(`Статус уже «${status}»`);
    const old = t.status;
    t.status = status;
    markTask(t, "status");
    if (status === "В работе" && !t.assignee_tg) {
      t.assignee_tg = actor.tg_id;
      t.assignee_notion = actor.notion_user_id;
      markTask(t, "assignee_notion");
    }
    await this.log(t, actor, status === DONE ? "done" : "status", `статус: ${old} → ${status}`);
    return this.save(t);
  }

  async setDue(t: Task, actor: Member, d: string | null): Promise<Task> {
    if (d) d = logic.skipHolidays(d);
    const old = t.due;
    t.due = d;
    if (t.start && d && t.start > d) { t.start = null; markTask(t, "start"); }
    markTask(t, "due");
    await this.log(t, actor, "due", `срок: ${fmt(old)} → ${fmt(d)}`);
    return this.save(t);
  }

  async postpone(t: Task, actor: Member, days: number): Promise<Task> {
    const today = this.today();
    const base = days > 0 ? ((t.due && t.due > today) ? t.due : today) : (t.due || today);
    return this.setDue(t, actor, addDays(base, days));
  }

  async setResult(t: Task, actor: Member, result: string): Promise<Task> {
    t.result = result.trim();
    markTask(t, "result");
    await this.log(t, actor, "result", `результат: ${t.result}`);
    if (t.status === "Не начато" || t.status === "В работе") {
      const old = t.status;
      t.status = "На проверке";
      markTask(t, "status");
      await this.log(t, actor, "status", `статус: ${old} → На проверке`);
    }
    return this.save(t);
  }

  async note(t: Task, actor: Member, text: string): Promise<Task> {
    await this.log(t, actor, "note", text.trim().slice(0, 500));
    return this.save(t);
  }

  // --- creation -------------------------------------------------------------------
  async create(actor: Member, title: string, stage: string, priority = "Средний", due: string | null = null,
               type = "Задача", description = ""): Promise<Task> {
    const t = newTask({
      id: "local-" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      title: title.trim().slice(0, 200), stage, type, priority,
      due: due ? logic.skipHolidays(due) : null, description,
    });
    markTask(t, "title", "stage", "type", "status", "priority", "due", "description");
    await this.log(t, actor, "create", "задача создана в боте");
    return this.save(t);
  }

  async promoteIdea(idea: Idea, actor: Member, stage: string): Promise<Task> {
    let desc = idea.description;
    if (idea.closes) desc = `${desc}\n\nЧто закрывает: ${idea.closes}`.trim();
    const t = await this.create(actor, idea.title, stage, "Средний", null, "Задача", desc);
    idea.status = "В задачах";
    idea.tasks.push(t.id);
    addDirty(idea, "status", "tasks");
    await this.st.saveIdea(idea);
    return t;
  }

  async rejectIdea(idea: Idea): Promise<Idea> {
    idea.status = "Отклонена";
    addDirty(idea, "status");
    await this.st.saveIdea(idea);
    return idea;
  }

  // --- milestones -----------------------------------------------------------------
  /** Recalculate milestone statuses from linked tasks. Returns changes [title, old, new]. */
  async refreshMilestones(): Promise<[string, string, string][]> {
    const tasks = await this.st.tasks();
    const today = this.today();
    const changes: [string, string, string][] = [];
    for (const m of await this.st.milestones()) {
      const s = logic.milestoneStatus(m, tasks, today);
      if (s !== m.status) {
        changes.push([m.title, m.status, s]);
        m.status = s;
        addDirty(m, "status");
        await this.st.saveMilestone(m);
      }
    }
    return changes;
  }

  async recordToday(): Promise<void> {
    const tasks = await this.st.tasks();
    const today = this.today();
    await this.st.recordDay(today, {
      overdue: logic.overdue(tasks, today).length,
      done: tasks.filter((t) => t.status === DONE).length,
      total: tasks.length,
      by_member: logic.overdueByMember(tasks, today),
    });
  }
}
