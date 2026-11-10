// D1 storage. Everything is a JSON document addressed by (kind, id):
//   task, milestone, idea, member, notion_user, kv, day
// Task history goes to the append-only `events` table.
// One Storage object per request: reads are cached until refresh(kind).
import type { D1Like } from "./config.ts";
import type { DayRec } from "./logic.ts";
import type { Event, Idea, Member, Milestone, Task } from "./models.ts";
import { newIdea, newMilestone, newTask } from "./models.ts";

export const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id))",
  "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, ts TEXT NOT NULL, task_id TEXT NOT NULL, data TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS events_task ON events (task_id, ts)",
  "CREATE INDEX IF NOT EXISTS events_ts ON events (ts)",
];

export class Storage {
  private cache = new Map<string, Map<string, any>>();
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  async ensureSchema(): Promise<void> {
    for (const q of SCHEMA) await this.db.prepare(q).run();
  }

  refresh(kind?: string): void {
    if (kind) this.cache.delete(kind);
    else this.cache.clear();
  }

  private async load(kind: string): Promise<Map<string, any>> {
    let m = this.cache.get(kind);
    if (m) return m;
    const r = await this.db.prepare("SELECT id, data FROM entities WHERE kind = ? ORDER BY id").bind(kind).all<{ id: string; data: string }>();
    m = new Map(r.results.map((row) => [row.id, JSON.parse(row.data)]));
    this.cache.set(kind, m);
    return m;
  }

  // --- primitives -----------------------------------------------------------
  async get<T = any>(kind: string, id: string): Promise<T | null> {
    const v = (await this.load(kind)).get(id);
    return v === undefined ? null : structuredClone(v);
  }

  async all<T = any>(kind: string): Promise<T[]> {
    return [...(await this.load(kind)).values()].map((v) => structuredClone(v));
  }

  async entries<T = any>(kind: string): Promise<[string, T][]> {
    return [...(await this.load(kind)).entries()].map(([k, v]) => [k, structuredClone(v)]);
  }

  async put(kind: string, id: string, data: unknown): Promise<void> {
    await this.db.prepare("INSERT INTO entities (kind, id, data) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data")
      .bind(kind, id, JSON.stringify(data)).run();
    const m = this.cache.get(kind);
    if (m) m.set(id, structuredClone(data));
  }

  async delete(kind: string, id: string): Promise<void> {
    await this.db.prepare("DELETE FROM entities WHERE kind = ? AND id = ?").bind(kind, id).run();
    this.cache.get(kind)?.delete(id);
  }

  async addEvent(ev: Event): Promise<void> {
    await this.db.prepare("INSERT OR REPLACE INTO events (id, ts, task_id, data) VALUES (?, ?, ?, ?)")
      .bind(ev.id, ev.ts, ev.task_id, JSON.stringify(ev)).run();
  }

  async events(since = "", taskId = ""): Promise<Event[]> {
    const r = taskId
      ? await this.db.prepare("SELECT data FROM events WHERE ts >= ? AND task_id = ? ORDER BY ts").bind(since, taskId).all<{ data: string }>()
      : await this.db.prepare("SELECT data FROM events WHERE ts >= ? ORDER BY ts").bind(since).all<{ data: string }>();
    return r.results.map((row) => JSON.parse(row.data));
  }

  // --- typed helpers ----------------------------------------------------------
  async tasks(includeArchived = false): Promise<Task[]> {
    const out = (await this.all<Task>("task")).map((d) => newTask(d));
    return includeArchived ? out : out.filter((t) => !t.archived);
  }

  async task(id: string): Promise<Task | null> {
    const d = await this.get<Task>("task", id);
    return d ? newTask(d) : null;
  }

  saveTask(t: Task): Promise<void> { return this.put("task", t.id, t); }

  async milestones(): Promise<Milestone[]> {
    const ms = (await this.all<Milestone>("milestone")).map((d) => newMilestone(d));
    return ms.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
  }

  saveMilestone(m: Milestone): Promise<void> { return this.put("milestone", m.id, m); }

  async ideas(): Promise<Idea[]> { return (await this.all<Idea>("idea")).map((d) => newIdea(d)); }

  async idea(id: string): Promise<Idea | null> {
    const d = await this.get<Idea>("idea", id);
    return d ? newIdea(d) : null;
  }

  saveIdea(i: Idea): Promise<void> { return this.put("idea", i.id, i); }

  members(): Promise<Member[]> { return this.all<Member>("member"); }
  member(tgId: number): Promise<Member | null> { return this.get<Member>("member", String(tgId)); }
  saveMember(m: Member): Promise<void> { return this.put("member", String(m.tg_id), m); }

  notionUsers(): Promise<{ id: string; name: string; type: string }[]> { return this.all("notion_user"); }

  async kvGet<T = any>(key: string, dflt: T | null = null): Promise<T | null> {
    const d = await this.get<{ v: T }>("kv", key);
    return d ? d.v : dflt;
  }

  kvSet(key: string, value: unknown): Promise<void> { return this.put("kv", key, { v: value }); }
  kvDel(key: string): Promise<void> { return this.delete("kv", key); }

  recordDay(day: string, rec: DayRec): Promise<void> { return this.put("day", day, rec); }

  async days(): Promise<Record<string, DayRec>> {
    return Object.fromEntries(await this.entries<DayRec>("day"));
  }
}
