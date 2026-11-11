// Minimal Notion REST client + property converters.
// Counts its HTTP calls: Cloudflare Free allows 50 subrequests per invocation.

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";
const RT_LIMIT = 2000;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface NotionApi {
  calls: number;
  query(dbId: string): Promise<any[]>;
  users(): Promise<any[]>;
  update(pageId: string, props: Record<string, unknown>): Promise<any>;
  create(dbId: string, props: Record<string, unknown>): Promise<any>;
  archive(pageId: string): Promise<any>;
  blocks?(blockId: string): Promise<any[]>;
}

export class NotionClient implements NotionApi {
  calls = 0;
  private token: string;
  private fetchFn: FetchFn;

  constructor(token: string, fetchFn: FetchFn = (i, init) => fetch(i, init)) {
    this.token = token;
    this.fetchFn = fetchFn;
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.calls += 1;
      const r = await this.fetchFn(API + path, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (r.status === 429 || r.status >= 500) {
        const wait = Number(r.headers.get("Retry-After") || 1 + attempt);
        await new Promise((res) => setTimeout(res, Math.min(wait, 3) * 1000));
        continue;
      }
      if (r.status >= 400) throw new Error(`Notion ${method} ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
      return r.json();
    }
    throw new Error(`Notion ${method} ${path}: too many retries`);
  }

  async query(dbId: string): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const data = await this.req("POST", `/databases/${dbId}/query`, cursor ? { page_size: 100, start_cursor: cursor } : { page_size: 100 });
      out.push(...data.results);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  async users(): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const data = await this.req("GET", `/users?page_size=100${cursor ? "&start_cursor=" + cursor : ""}`);
      out.push(...data.results);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  /** Child blocks of a page (first 100 are plenty for a task page). */
  async blocks(blockId: string): Promise<any[]> {
    const data = await this.req("GET", `/blocks/${blockId}/children?page_size=100`);
    return data.results || [];
  }

  update(pageId: string, props: Record<string, unknown>): Promise<any> {
    return this.req("PATCH", `/pages/${pageId}`, { properties: props });
  }

  create(dbId: string, props: Record<string, unknown>): Promise<any> {
    return this.req("POST", "/pages", { parent: { database_id: dbId }, properties: props });
  }

  archive(pageId: string): Promise<any> {
    return this.req("PATCH", `/pages/${pageId}`, { archived: true });
  }
}

// --- reading --------------------------------------------------------------------

export const nid = (x: string): string => (x || "").replace(/-/g, "");
const plain = (rt: any[]): string => (rt || []).map((x) => x.plain_text ?? x.text?.content ?? "").join("");

/** Notion property → JS value (string | string[] | [start, end] | null). */
export function read(prop: any): any {
  if (!prop) return null;
  const t = prop.type;
  const v = prop[t];
  switch (t) {
    case "title":
    case "rich_text": return plain(v);
    case "select":
    case "status": return v ? v.name : "";
    case "multi_select": return (v || []).map((x: any) => x.name);
    case "date": return v ? [v.start ?? null, v.end ?? null] : [null, null];
    case "people": return (v || []).map((x: any) => x.id);
    case "relation": return (v || []).map((x: any) => nid(x.id));
    case "url":
    case "number":
    case "checkbox":
    case "email":
    case "phone_number": return v;
    default: return null;
  }
}

// --- writing --------------------------------------------------------------------

function chunks(text: string): unknown[] {
  const out: unknown[] = [];
  const s = text || "";
  for (let i = 0; i < s.length && out.length < 100; i += RT_LIMIT) out.push({ type: "text", text: { content: s.slice(i, i + RT_LIMIT) } });
  return out;
}

/** JS value → Notion property payload for a property of type `ptype`. */
export function write(ptype: string, value: any): unknown {
  switch (ptype) {
    case "title": return { title: chunks(value) };
    case "rich_text": return { rich_text: chunks(value) };
    case "select": return { select: value ? { name: value } : null };
    case "status": return { status: value ? { name: value } : null };
    case "url": return { url: value || null };
    case "people": return { people: (value || []).map((x: string) => ({ id: x })) };
    case "relation": return { relation: (value || []).map((x: string) => ({ id: x })) };
    case "date": {
      const [start, end] = value as [string | null, string | null];
      if (!start && !end) return { date: null };
      const d: Record<string, string> = { start: (start || end)! };
      if (start && end && start !== end) d.end = end;
      return { date: d };
    }
  }
  throw new Error(`unsupported property type ${ptype}`);
}

export function propTypes(pages: any[]): Record<string, string> {
  const types: Record<string, string> = {};
  for (const p of pages) for (const [name, prop] of Object.entries<any>(p.properties || {})) types[name] ??= prop.type;
  return types;
}

/** Notion blocks → plain text with simple Markdown-ish prefixes. */
export function blocksToText(blocks: any[]): string {
  const out: string[] = [];
  let n = 0;
  for (const b of blocks) {
    const v = b?.[b?.type] || {};
    const txt = (v.rich_text || []).map((r: any) => r.plain_text || "").join("").trim();
    if (b.type !== "numbered_list_item") n = 0;
    switch (b.type) {
      case "heading_1": case "heading_2": case "heading_3": if (txt) out.push("", txt.toUpperCase()); break;
      case "bulleted_list_item": if (txt) out.push("• " + txt); break;
      case "numbered_list_item": if (txt) out.push(`${++n}. ${txt}`); break;
      case "to_do": if (txt) out.push((v.checked ? "☑ " : "☐ ") + txt); break;
      case "quote": case "callout": if (txt) out.push("» " + txt); break;
      case "code": if (txt) out.push(txt); break;
      case "bookmark": case "embed": case "link_preview": if (v.url) out.push(v.url); break;
      case "child_page": out.push("[страница] " + (v.title || "")); break;
      default: if (txt) out.push(txt);
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Text inside a task's Notion page, cached in D1 until the page is edited again. */
export async function pageText(notion: NotionApi | null, st: { get<T>(k: string, id: string): Promise<T | null>; put(k: string, id: string, v: unknown): Promise<void> },
  t: { id: string; notion_id: string | null; notion_edited: string }): Promise<string> {
  if (!t.notion_id) return "";
  const cached = await st.get<{ edited: string; text: string }>("body", t.id);
  if (cached && cached.edited === t.notion_edited) return cached.text;
  if (!notion?.blocks) return cached?.text || "";
  const text = blocksToText(await notion.blocks(t.notion_id)).slice(0, 6000);
  await st.put("body", t.id, { edited: t.notion_edited, text });
  return text;
}
