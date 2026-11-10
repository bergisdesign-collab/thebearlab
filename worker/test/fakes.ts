// Test doubles: D1 on top of node:sqlite, a fake Notion API with real page shapes, a fake Telegram.
import { DatabaseSync } from "node:sqlite";
import type { D1Like, D1Stmt } from "../src/config.ts";
import { NOTION_IDEAS_DB, NOTION_MILESTONES_DB, NOTION_TASKS_DB } from "../src/config.ts";
import type { NotionApi } from "../src/notion.ts";
import { Storage } from "../src/storage.ts";

export const NOW = new Date("2026-11-05T06:00:00Z");   // 09:00 MSK, Thursday
export const at = (iso: string): (() => Date) => () => new Date(iso);

export class SqliteD1 implements D1Like {
  db = new DatabaseSync(":memory:");
  writes: string[] = [];

  prepare(query: string): D1Stmt {
    const self = this;
    const make = (args: unknown[]): D1Stmt => ({
      bind: (...v: unknown[]) => make(v),
      async all<T>() { return { results: self.db.prepare(query).all(...(args as any[])) as T[] }; },
      async first<T>() { return (self.db.prepare(query).get(...(args as any[])) as T) ?? null; },
      async run() {
        if (/^\s*(insert|update|delete)/i.test(query)) self.writes.push(`${query.split(" ")[0]}:${String(args[0])}:${String(args[1] ?? "")}`);
        return self.db.prepare(query).run(...(args as any[]));
      },
    });
    return make([]);
  }
}

export async function newStore(): Promise<{ d1: SqliteD1; st: Storage }> {
  const d1 = new SqliteD1();
  const st = new Storage(d1);
  await st.ensureSchema();
  return { d1, st };
}

let counter = 1;
export const newId = (): string => (counter++).toString(16).padStart(32, "0");
const dash = (i: string): string => `${i.slice(0, 8)}-${i.slice(8, 12)}-${i.slice(12, 16)}-${i.slice(16, 20)}-${i.slice(20)}`;

/** Build a property as Notion returns it. */
export function P(ptype: string, value: any): any {
  switch (ptype) {
    case "title":
    case "rich_text": return { type: ptype, [ptype]: value ? [{ plain_text: value, text: { content: value } }] : [] };
    case "select":
    case "status": return { type: ptype, [ptype]: value ? { name: value } : null };
    case "date": {
      if (!value) return { type: "date", date: null };
      const [s, e] = Array.isArray(value) ? value : [value, null];
      return { type: "date", date: { start: s, end: e } };
    }
    case "people": return { type: "people", people: (value || []).map((x: string) => ({ id: x })) };
    case "relation": return { type: "relation", relation: (value || []).map((x: string) => ({ id: dash(x) })) };
    case "url": return { type: "url", url: value };
  }
  throw new Error(ptype);
}

export class FakeNotion implements NotionApi {
  calls = 0;
  log: [string, ...any[]][] = [];
  dbs: Record<string, Map<string, any>> = { [NOTION_TASKS_DB]: new Map(), [NOTION_MILESTONES_DB]: new Map(), [NOTION_IDEAS_DB]: new Map() };
  usersList = [
    { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "Сергей", type: "person" },
    { id: "aaaaaaaa-0000-0000-0000-000000000002", name: "Аня", type: "person" },
    { id: "bbbbbbbb-0000-0000-0000-000000000009", name: "Integration", type: "bot" },
  ];
  private clock = 1;

  add(db: string, props: any, pid = ""): string {
    pid = pid || newId();
    this.dbs[db].set(pid, { id: dash(pid), properties: props, last_edited_time: `2026-11-01T00:00:${String(this.clock++ % 60).padStart(2, "0")}.000Z` });
    return pid;
  }

  page(pid: string): any {
    for (const db of Object.values(this.dbs)) if (db.has(pid)) return db.get(pid);
    throw new Error("no page " + pid);
  }

  edit(pid: string, name: string, prop: any): void {   // a human editing in Notion
    const pg = this.page(pid);
    pg.properties[name] = prop;
    pg.last_edited_time = `2026-11-05T10:${String(this.clock++ % 60).padStart(2, "0")}:00.000Z`;
  }

  async query(dbId: string): Promise<any[]> {
    this.calls++;
    this.log.push(["query", dbId]);
    return [...this.dbs[dbId].values()].map((p) => structuredClone(p));
  }

  async users(): Promise<any[]> {
    this.calls++;
    this.log.push(["users"]);
    return structuredClone(this.usersList);
  }

  private static toRead(payload: any): any {
    const [[ptype, v]] = Object.entries<any>(payload);
    if (ptype === "title" || ptype === "rich_text") return { type: ptype, [ptype]: v.map((c: any) => ({ plain_text: c.text.content })) };
    if (ptype === "relation") return { type: ptype, relation: v.map((x: any) => ({ id: x.id.length === 32 ? dash(x.id) : x.id })) };
    return { type: ptype, [ptype]: v };
  }

  async update(pageId: string, props: Record<string, unknown>): Promise<any> {
    this.calls++;
    this.log.push(["update", pageId, props]);
    const pg = this.page(pageId.replace(/-/g, ""));
    for (const [name, payload] of Object.entries(props)) pg.properties[name] = FakeNotion.toRead(payload);
    return pg;
  }

  async create(dbId: string, props: Record<string, unknown>): Promise<any> {
    this.calls++;
    this.log.push(["create", dbId, props]);
    const pid = newId();
    const full: any = {};
    for (const [name, payload] of Object.entries(props)) full[name] = FakeNotion.toRead(payload);
    const pg = { id: dash(pid), properties: full, last_edited_time: "2026-11-05T09:00:00.000Z" };
    this.dbs[dbId].set(pid, pg);
    return pg;
  }
}

export function taskProps(title: string, o: { stage?: string; status?: string; priority?: string; due?: any; type?: string; ms?: string[]; deps?: string[]; people?: string[]; desc?: string } = {}): any {
  return {
    "Задача": P("title", title), "Этап": P("select", o.stage ?? "1. Концепция игры"), "Тип": P("select", o.type ?? "Задача"),
    "Статус": P("status", o.status ?? "Не начато"), "Приоритет": P("select", o.priority ?? "Средний"), "Срок": P("date", o.due ?? null),
    "Описание": P("rich_text", o.desc ?? ""), "Исполнитель": P("people", o.people ?? []), "Веха": P("relation", o.ms ?? []),
    "Зависит от": P("relation", o.deps ?? []), "Результат": P("url", null), "Журнал": P("rich_text", ""),
  };
}

/** A small roadmap shaped like the real one. */
export function seed(fn: FakeNotion): Record<string, string> {
  const M = NOTION_MILESTONES_DB, T = NOTION_TASKS_DB, I = NOTION_IDEAS_DB;
  const ids: Record<string, string> = {};
  ids.ms_ny = fn.add(M, { "Веха": P("title", "Решение по Новому году"), "Дата": P("date", "2026-11-12"), "Статус": P("status", "Впереди"), "Критерий": P("rich_text", "Решение принято") });
  ids.ms_launch = fn.add(M, { "Веха": P("title", "Запуск продаж"), "Дата": P("date", "2027-02-05"), "Статус": P("status", "Впереди"), "Критерий": P("rich_text", "") });
  ids.t_decide = fn.add(T, taskProps("Решить, успеваем ли к Новому году", { type: "Решение", priority: "Высокий", due: "2026-11-10", ms: [ids.ms_ny] }));
  ids.t_gdd = fn.add(T, taskProps("Написать гейм-диздок", { priority: "Высокий", due: "2026-11-03", people: ["aaaaaaaa-0000-0000-0000-000000000002"] }));
  ids.t_after = fn.add(T, taskProps("Утвердить гейм-диздок", { deps: [ids.t_gdd], due: "2026-11-20" }));
  ids.t_fabric = fn.add(T, taskProps("Найти поставщика ткани", { stage: "4. Производство", due: "2026-11-30", desc: "Плюш, мех, сертификаты" }));
  ids.t_done = fn.add(T, taskProps("Собрать референсы", { stage: "2. Поиск концепта", status: "Готово", ms: [ids.ms_ny] }));
  ids.idea = fn.add(I, { "Идея": P("title", "Паспорт мишки"), "Группа": P("select", "Эмоции"), "Очередь": P("select", "MVP"), "Статус": P("status", "Новая"),
    "Описание": P("rich_text", "Карточка с именем"), "Что закрывает": P("rich_text", "Привязанность"), "Задача": P("relation", []) });
  return ids;
}

/** Records Telegram Bot API calls made through fetch. */
export class FakeTelegram {
  sent: { method: string; body: any }[] = [];
  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = url.split("/").pop()!;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    this.sent.push({ method, body });
    if (method === "editMessageText" && body.text === "__fail__") return Response.json({ ok: false, description: "Bad Request" });
    return Response.json({ ok: true, result: { message_id: this.sent.length } });
  };
  methods(): string[] { return this.sent.map((s) => s.method); }
}
