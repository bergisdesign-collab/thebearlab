// Two-way Notion ↔ D1 sync. Full sync on every cron tick (10 min) and on /sync; push of the bot's
// own changes right after each Telegram action.
//   * Pull: Notion overwrites the bot copy EXCEPT fields the bot changed and has not pushed (dirty).
//   * Push: only dirty fields are sent; a field leaves `dirty` only if it still has the pushed value.
//   * Tasks created in the bot ("local-…") become Notion pages; Notion page id goes to notion_id.
//   * Pages deleted in Notion are archived in the bot.
//   * Nothing is written unless it changed. Push respects a subrequest budget (Cloudflare limit).
import { NOTION_IDEAS_DB, NOTION_MEMORY_DB, NOTION_MILESTONES_DB, NOTION_TASKS_DB, msk } from "./config.ts";
import { KINDS, SOURCES, newMemory } from "./memory.ts";
import type { Memory } from "./memory.ts";
import type { Clock } from "./config.ts";
import { isDone, newIdea, newMilestone, newTask } from "./models.ts";
import type { Idea, Milestone, Task } from "./models.ts";
import { nid, propTypes, read, write } from "./notion.ts";
import type { NotionApi } from "./notion.ts";
import { Service } from "./service.ts";
import type { Storage } from "./storage.ts";

const TASK_PROPS: Record<string, string> = {
  title: "Задача", stage: "Этап", type: "Тип", status: "Статус", priority: "Приоритет", description: "Описание",
  result: "Результат", assignee_notion: "Исполнитель", log: "Журнал", milestones: "Веха", depends_on: "Зависит от", due: "Срок",
};
const TASK_TYPES: Record<string, string> = {
  "Задача": "title", "Этап": "select", "Тип": "select", "Статус": "status", "Приоритет": "select", "Описание": "rich_text",
  "Результат": "url", "Исполнитель": "people", "Журнал": "rich_text", "Веха": "relation", "Зависит от": "relation", "Срок": "date",
};
const MS_PROPS: Record<string, string> = { title: "Веха", date: "Дата", status: "Статус", criterion: "Критерий" };
const MS_TYPES: Record<string, string> = { "Веха": "title", "Дата": "date", "Статус": "status", "Критерий": "rich_text" };
const IDEA_PROPS: Record<string, string> = { title: "Идея", group: "Группа", queue: "Очередь", status: "Статус", description: "Описание", closes: "Что закрывает", tasks: "Задача" };
const IDEA_TYPES: Record<string, string> = { "Идея": "title", "Группа": "select", "Очередь": "select", "Статус": "status", "Описание": "rich_text", "Что закрывает": "rich_text", "Задача": "relation" };

const USERS_EVERY_MS = 60 * 60 * 1000;   // Notion users rarely change: pull them hourly

type PropTypes = { task: Record<string, string>; ms: Record<string, string>; idea: Record<string, string> };

export interface Report { pulled: Record<string, number>; created: number; pushed: number; archived: number; errors: string[]; deferred: number; assigned?: [string, number][] }

export function shortReport(r: Report): string {
  let s = `Задач: ${r.pulled.tasks ?? 0}, вех: ${r.pulled.milestones ?? 0}, идей: ${r.pulled.ideas ?? 0}. Отправлено изменений: ${r.pushed}, новых страниц: ${r.created}.`;
  if (r.deferred) s += ` Ещё ${r.deferred} уйдут со следующей синхронизацией.`;
  if (r.errors.length) s += ` Ошибок: ${r.errors.length}.`;
  return s;
}

const d10 = (v: string | null): string | null => (v ? v.slice(0, 10) : null);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class Syncer {
  n: NotionApi;
  st: Storage;
  clock: Clock;
  budget: number;
  r: Report = { pulled: {}, created: 0, pushed: 0, archived: 0, errors: [], deferred: 0 };
  types: PropTypes = { task: { ...TASK_TYPES }, ms: { ...MS_TYPES }, idea: { ...IDEA_TYPES } };
  n2l = new Map<string, string>();   // Notion page id → bot task id
  l2n = new Map<string, string>();   // bot task id → Notion page id

  /** budget = max Notion calls this run may make (keep room for Telegram calls in the same invocation). */
  constructor(n: NotionApi, st: Storage, clock: Clock, budget = 40) {
    this.n = n;
    this.st = st;
    this.clock = clock;
    this.budget = budget;
  }

  private async loadTypes(): Promise<void> {
    const saved: Partial<PropTypes> = (await this.st.kvGet<PropTypes>("notion_types")) || {};
    this.types = { task: { ...TASK_TYPES, ...saved.task }, ms: { ...MS_TYPES, ...saved.ms }, idea: { ...IDEA_TYPES, ...saved.idea } };
  }

  private learn(key: "task" | "ms" | "idea", pages: any[]): void {
    for (const [name, t] of Object.entries(propTypes(pages))) if (name in this.types[key]) this.types[key][name] = t;
  }

  private async buildMaps(): Promise<void> {
    for (const t of await this.st.tasks(true)) {
      if (t.notion_id) { this.n2l.set(t.notion_id, t.id); this.l2n.set(t.id, t.notion_id); }
    }
  }

  private canCall(): boolean { return this.n.calls < this.budget; }

  // ------------------------------------------------------------------- pull
  async pullUsers(force = false): Promise<void> {
    const last = (await this.st.kvGet<number>("users_pulled")) || 0;
    if (!force && this.clock().getTime() - last < USERS_EVERY_MS) return;
    const users = await this.n.users();
    for (const u of users) {
      const rec = { id: u.id, name: u.name || "", type: u.type || "person" };
      if (!same(await this.st.get("notion_user", u.id), rec)) await this.st.put("notion_user", u.id, rec);
    }
    await this.st.kvSet("users_pulled", this.clock().getTime());
    this.r.pulled.users = users.length;
  }

  async pullMilestones(): Promise<void> {
    const pages = await this.n.query(NOTION_MILESTONES_DB);
    this.learn("ms", pages);
    for (const p of pages) {
      const pid = nid(p.id);
      const pr = p.properties;
      const remote: Partial<Milestone> = {
        title: read(pr["Веха"]) || "", date: d10((read(pr["Дата"]) || [null])[0]),
        status: read(pr["Статус"]) || "Впереди", criterion: read(pr["Критерий"]) || "",
      };
      const cur = await this.st.get<Milestone>("milestone", pid);
      const m = cur ? newMilestone(cur) : newMilestone({ id: pid, title: remote.title! });
      const before = JSON.stringify(m);
      for (const [f, v] of Object.entries(remote)) if (!m.dirty.includes(f)) (m as any)[f] = v;
      if (!cur || JSON.stringify(m) !== before) await this.st.saveMilestone(m);
    }
    this.r.pulled.milestones = pages.length;
  }

  private parseTask(p: any): Partial<Task> {
    const pr = p.properties;
    const [s, e] = read(pr["Срок"]) || [null, null];
    const people: string[] = read(pr["Исполнитель"]) || [];
    return {
      title: read(pr["Задача"]) || "",
      stage: read(pr["Этап"]) || "",
      type: read(pr["Тип"]) || "Задача",
      status: read(pr["Статус"]) || "Не начато",
      priority: read(pr["Приоритет"]) || "Средний",
      start: e ? d10(s) : null,
      due: e ? d10(e) : d10(s),
      description: read(pr["Описание"]) || "",
      result: read(pr["Результат"]) || "",
      assignee_notion: people[0] || null,
      co_notion: people.slice(1),
      log: read(pr["Журнал"]) || "",
      milestones: read(pr["Веха"]) || [],
      depends_on: ((read(pr["Зависит от"]) || []) as string[]).map((x) => this.n2l.get(x) || x),
    };
  }

  private static merge(t: Task, remote: Partial<Task>, byNotionUser: Map<string, number>): Task {
    const dirty = new Set(t.dirty);
    if (dirty.has("start") || dirty.has("due")) { dirty.add("start"); dirty.add("due"); }
    for (const [f, v] of Object.entries(remote)) {
      if (dirty.has(f)) continue;
      if (f === "assignee_notion") {
        if (v !== t.assignee_notion) {
          t.assignee_notion = v as string | null;
          t.assignee_tg = (v && byNotionUser.get(v as string)) || null;
        }
        continue;
      }
      if (f === "co_notion") {
        if (dirty.has("assignee_notion")) continue;
        const list = (v as string[]) || [];
        const linkedTg = new Set(byNotionUser.values());
        // partners without a Notion link exist only in the bot: keep them
        const botOnly = (t.co_tg || []).filter((x) => !linkedTg.has(x));
        t.co_notion = list;
        t.co_tg = [...new Set([...list.map((x) => byNotionUser.get(x)).filter((x): x is number => !!x), ...botOnly])].filter((x) => x !== t.assignee_tg);
        continue;
      }
      (t as any)[f] = v;
    }
    return t;
  }

  async pullTasks(): Promise<void> {
    const pages = await this.n.query(NOTION_TASKS_DB);
    this.learn("task", pages);
    await this.buildMaps();
    for (const p of pages) if (!this.n2l.has(nid(p.id))) this.n2l.set(nid(p.id), nid(p.id));
    this.l2n = new Map([...this.n2l.entries()].map(([k, v]) => [v, k]));
    const users = new Map((await this.st.members()).filter((m) => m.notion_user_id).map((m) => [m.notion_user_id!, m.tg_id]));
    const remotes = new Map(pages.map((p) => [nid(p.id), { p, remote: this.parseTask(p) }]));

    // Re-read right before writing so edits made in the bot meanwhile are not overwritten.
    this.st.refresh("task");
    const local = new Map((await this.st.tasks(true)).map((t) => [t.id, t]));
    const firstPull = local.size === 0;
    for (const [pid, { p, remote }] of remotes) {
      const lid = this.n2l.get(pid)!;
      const cur = local.get(lid);
      let t = cur ? newTask(cur) : newTask({ id: lid, title: remote.title!, notion_id: pid });
      const before = cur ? JSON.stringify(cur) : "";
      t.notion_id = pid;
      t = Syncer.merge(t, remote, users);
      t.notion_edited = p.last_edited_time || "";
      t.archived = false;
      if (JSON.stringify(t) !== before) await this.st.saveTask(t);
      // done or created right in Notion → into the history like any bot action
      if (!firstPull && ((cur && !isDone(cur) && isDone(t)) || !cur)) {
        const iso = msk(this.clock()).iso;
        await this.st.addEvent({ id: crypto.randomUUID().replace(/-/g, ""), ts: iso, task_id: t.id, actor: "Notion", kind: cur ? "done" : "create", text: cur ? "выполнена (отмечено в Notion)" : "создана в Notion" });
      }
      // someone was put on the task in Notion → their cabinet gets a card
      if (cur && t.assignee_tg && t.assignee_tg !== cur.assignee_tg && !isDone(t)) (this.r.assigned ||= []).push([t.id, t.assignee_tg]);
    }
    for (const t of local.values()) {
      if (t.notion_id && !remotes.has(t.notion_id) && !t.archived) {
        t.archived = true;
        await this.st.saveTask(t);
        this.r.archived += 1;
      }
    }
    this.r.pulled.tasks = pages.length;
  }

  async pullIdeas(): Promise<void> {
    const pages = await this.n.query(NOTION_IDEAS_DB);
    this.learn("idea", pages);
    this.st.refresh("idea");
    for (const p of pages) {
      const pid = nid(p.id);
      const pr = p.properties;
      const remote: Partial<Idea> = {
        title: read(pr["Идея"]) || "", group: read(pr["Группа"]) || "", queue: read(pr["Очередь"]) || "",
        status: read(pr["Статус"]) || "Новая", description: read(pr["Описание"]) || "", closes: read(pr["Что закрывает"]) || "",
        tasks: ((read(pr["Задача"]) || []) as string[]).map((x) => this.n2l.get(x) || x),
      };
      const cur = await this.st.get<Idea>("idea", pid);
      const i = cur ? newIdea(cur) : newIdea({ id: pid, title: remote.title! });
      const before = JSON.stringify(i);
      for (const [f, v] of Object.entries(remote)) if (!i.dirty.includes(f)) (i as any)[f] = v;
      if (!cur || JSON.stringify(i) !== before) await this.st.saveIdea(i);
    }
    this.r.pulled.ideas = pages.length;
  }

  // ------------------------------------------------------------------- push
  private taskValue(t: Task, f: string): unknown {
    if (f === "due") return [t.start, t.due];
    if (f === "assignee_notion") return [...new Set([t.assignee_notion, ...(t.co_notion || [])].filter(Boolean))];
    if (f === "depends_on") return t.depends_on.filter((x) => this.l2n.has(x)).map((x) => this.l2n.get(x));
    return (t as any)[f];
  }

  async pushTasks(): Promise<void> {
    const sent: [Task, Record<string, unknown>][] = [];
    for (const t of await this.st.tasks(true)) {
      if (!t.dirty.length || (t.archived && !t.id.startsWith("local-"))) continue;
      if (!this.canCall()) { this.r.deferred += 1; continue; }
      const fields = [...new Set(t.dirty.map((f) => (f === "start" ? "due" : f)))];
      const snapshot: Record<string, unknown> = {};
      for (const f of t.dirty) snapshot[f] = structuredClone((t as any)[f]);
      const props: Record<string, unknown> = {};
      for (const f of fields) {
        const name = TASK_PROPS[f];
        if (!name) continue;
        const v = this.taskValue(t, f);
        if (!t.notion_id && (v === null || v === "" || (Array.isArray(v) && (!v.length || v.every((x) => x === null))))) continue;
        props[name] = write(this.types.task[name], v);
      }
      try {
        if (t.notion_id) await this.n.update(t.notion_id, props);
        else {
          const page = await this.n.create(NOTION_TASKS_DB, props);
          t.notion_id = nid(page.id);
          this.n2l.set(t.notion_id, t.id);
          this.l2n.set(t.id, t.notion_id);
          this.r.created += 1;
        }
      } catch (e) {
        this.r.errors.push(`task ${t.title}: ${e}`);
        continue;
      }
      sent.push([t, snapshot]);
    }
    if (!sent.length) return;
    this.st.refresh("task");
    for (const [t, snapshot] of sent) {
      const fresh = (await this.st.task(t.id)) || t;
      fresh.notion_id = t.notion_id;
      const unresolved = fresh.depends_on.some((x) => !this.l2n.has(x));
      fresh.dirty = fresh.dirty.filter((f) => !(f in snapshot && same((fresh as any)[f], snapshot[f])) || (f === "depends_on" && unresolved));
      await this.st.saveTask(fresh);
      this.r.pushed += 1;
    }
  }

  async pushMilestones(): Promise<void> {
    for (const m of await this.st.milestones()) {
      if (!m.dirty.length) continue;
      if (!this.canCall()) { this.r.deferred += 1; continue; }
      const snap: Record<string, unknown> = {};
      const props: Record<string, unknown> = {};
      for (const f of m.dirty) {
        snap[f] = (m as any)[f];
        const name = MS_PROPS[f];
        if (name) props[name] = write(this.types.ms[name], f === "date" ? [m.date, null] : (m as any)[f]);
      }
      try { await this.n.update(m.id, props); } catch (e) { this.r.errors.push(`milestone ${m.title}: ${e}`); continue; }
      this.st.refresh("milestone");
      const cur = await this.st.get<Milestone>("milestone", m.id);
      const fresh = cur ? newMilestone(cur) : m;
      fresh.dirty = fresh.dirty.filter((f) => !(f in snap && same((fresh as any)[f], snap[f])));
      await this.st.saveMilestone(fresh);
      this.r.pushed += 1;
    }
  }

  async pushIdeas(): Promise<void> {
    for (const i of await this.st.ideas()) {
      if (!i.dirty.length) continue;
      if (!this.canCall()) { this.r.deferred += 1; continue; }
      const snap: Record<string, unknown> = {};
      const props: Record<string, unknown> = {};
      const keep: string[] = [];
      for (const f of i.dirty) {
        snap[f] = structuredClone((i as any)[f]);
        const name = IDEA_PROPS[f];
        if (!name) continue;
        let v = (i as any)[f];
        if (f === "tasks") {
          const pending = (v as string[]).filter((x) => x.startsWith("local-") && !this.l2n.has(x));
          if (pending.length) keep.push(f);   // task not in Notion yet
          v = (v as string[]).filter((x) => !pending.includes(x)).map((x) => this.l2n.get(x) || x);
        }
        props[name] = write(this.types.idea[name], v);
      }
      try { await this.n.update(i.id, props); } catch (e) { this.r.errors.push(`idea ${i.title}: ${e}`); continue; }
      this.st.refresh("idea");
      const cur = await this.st.get<Idea>("idea", i.id);
      const fresh = cur ? newIdea(cur) : i;
      fresh.dirty = fresh.dirty.filter((f) => keep.includes(f) || !(f in snap && same((fresh as any)[f], snap[f])));
      await this.st.saveIdea(fresh);
      this.r.pushed += 1;
    }
  }

  // ------------------------------------------------------------------- memory ↔ «Память команды»
  async pullMemory(): Promise<void> {
    let pages: any[];
    try { pages = await this.n.query(NOTION_MEMORY_DB); } catch (e) { this.r.errors.push(`memory pull: ${e}`); return; }
    this.st.refresh("memory");
    const local = (await this.st.all<Memory>("memory")).map((m) => newMemory(m));
    const byNotion = new Map(local.filter((m) => m.notion_id).map((m) => [m.notion_id!, m]));
    const byId = new Map(local.map((m) => [m.id, m]));
    const tombs = new Set((await this.st.all<{ notion_id: string }>("memory_tomb")).map((t) => t.notion_id));
    const seen = new Set<string>();
    for (const p of pages) {
      const pid = nid(p.id);
      if (tombs.has(pid)) continue;
      seen.add(pid);
      const pr = p.properties;
      const text = read(pr["Запись"]) || "";
      const kind = read(pr["Вид"]) || "Факт";
      const code = read(pr["Код"]) || "";
      let m = byNotion.get(pid) || (code ? byId.get(code) : undefined);
      if (!m) {
        if (!text) continue;
        m = newMemory({ id: code || pid.slice(0, 8), text, kind: KINDS.includes(kind) ? kind : "Факт",
          source: SOURCES.includes(read(pr["Источник"])) ? read(pr["Источник"]) : "Notion",
          by: read(pr["Кто"]) || "", ts: (read(pr["Дата"]) || [""])[0] || p.created_time || "", notion_id: pid });
        await this.st.put("memory", m.id, m);
        continue;
      }
      const before = JSON.stringify(m);
      m.notion_id = pid;
      if (!m.dirty) { m.text = text || m.text; m.kind = KINDS.includes(kind) ? kind : m.kind; }
      if (JSON.stringify(m) !== before) await this.st.put("memory", m.id, m);
    }
    for (const m of local) {   // deleted in Notion → forget here too
      if (m.notion_id && !seen.has(m.notion_id) && !tombs.has(m.notion_id)) await this.st.delete("memory", m.id);
    }
    this.r.pulled.memory = pages.length;
  }

  async pushMemory(): Promise<void> {
    for (const t of await this.st.all<{ notion_id: string }>("memory_tomb")) {
      if (!this.canCall()) { this.r.deferred += 1; continue; }
      try { await this.n.archive(t.notion_id); } catch (e) { this.r.errors.push(`memory archive: ${e}`); continue; }
      await this.st.delete("memory_tomb", t.notion_id);
    }
    for (const m of (await this.st.all<Memory>("memory")).map((x) => newMemory(x))) {
      if (m.notion_id && !m.dirty) continue;
      if (!this.canCall()) { this.r.deferred += 1; continue; }
      const props = {
        "Запись": write("title", m.text), "Вид": write("select", m.kind), "Источник": write("select", m.source),
        "Кто": write("rich_text", m.by), "Дата": write("date", [m.ts ? m.ts.slice(0, 10) : null, null]), "Код": write("rich_text", m.id),
      };
      try {
        if (m.notion_id) await this.n.update(m.notion_id, props);
        else m.notion_id = nid((await this.n.create(NOTION_MEMORY_DB, props)).id);
      } catch (e) { this.r.errors.push(`memory push: ${e}`); continue; }
      const fresh = (await this.st.get<Memory>("memory", m.id)) || m;
      await this.st.put("memory", m.id, { ...fresh, notion_id: m.notion_id, dirty: fresh.text !== m.text || fresh.kind !== m.kind });
      this.r.pushed += 1;
    }
  }

  // ------------------------------------------------------------------- run
  async hasLocalChanges(): Promise<boolean> {
    if ((await this.st.all<Memory>("memory")).some((m) => m.dirty || !m.notion_id)) return true;
    if ((await this.st.all("memory_tomb")).length) return true;
    return (await this.st.tasks(true)).some((t) => t.dirty.length > 0)
      || (await this.st.milestones()).some((m) => m.dirty.length > 0)
      || (await this.st.ideas()).some((i) => i.dirty.length > 0);
  }

  /** Only send the bot's own changes (used right after a Telegram action). */
  async push(): Promise<Report> {
    await this.loadTypes();
    await this.buildMaps();
    await this.pushTasks();
    await this.pushIdeas();
    await this.pushMilestones();
    await this.pushMemory();
    return this.r;
  }

  async run(forceUsers = false): Promise<Report> {
    await this.loadTypes();
    await this.pullUsers(forceUsers);
    await this.pullMilestones();
    await this.pullTasks();
    await this.pullIdeas();
    await this.pullMemory();
    if (!same(await this.st.kvGet("notion_types"), this.types)) await this.st.kvSet("notion_types", this.types);
    await new Service(this.st, this.clock).refreshMilestones();
    await this.pushTasks();
    await this.pushIdeas();
    await this.pushMilestones();
    await this.pushMemory();
    await this.st.kvSet("last_sync", msk(this.clock()).iso);
    return this.r;
  }
}
