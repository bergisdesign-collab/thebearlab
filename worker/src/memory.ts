// Team memory: decisions, conclusions, agreements and facts the bot keeps from conversations.
// Stored in D1 (kind "memory") and mirrored to the Notion database «Память команды».
// Group chat conclusions: messages are buffered briefly, then the model extracts what is worth keeping;
// the buffer is deleted right after.
import { msk } from "./config.ts";
import type { Clock } from "./config.ts";
import type { Storage } from "./storage.ts";

export const KINDS = ["Решение", "Вывод", "Договорённость", "Факт"];
export const SOURCES = ["Личка", "Общий чат", "Notion"];

export interface Memory {
  id: string;
  text: string;
  kind: string;
  source: string;
  by: string;
  ts: string;
  notion_id: string | null;
  dirty: boolean;       // needs to be pushed to Notion
}

export function newMemory(p: Partial<Memory> & { id: string; text: string }): Memory {
  return { kind: "Факт", source: "Личка", by: "", ts: "", notion_id: null, dirty: false, ...p };
}

export async function memories(st: Storage): Promise<Memory[]> {
  return (await st.all<Memory>("memory")).map((m) => newMemory(m)).sort((a, b) => a.ts.localeCompare(b.ts));
}

export async function remember(st: Storage, clock: Clock, text: string, kind: string, source: string, by: string): Promise<Memory> {
  const clean = text.trim().slice(0, 500);
  // do not store the same thing twice
  const dup = (await memories(st)).find((m) => norm(m.text) === norm(clean));
  if (dup) return dup;
  const m = newMemory({
    id: crypto.randomUUID().replace(/-/g, "").slice(0, 8), text: clean,
    kind: KINDS.includes(kind) ? kind : "Факт", source: SOURCES.includes(source) ? source : "Личка",
    by, ts: msk(clock()).iso, dirty: true,
  });
  await st.put("memory", m.id, m);
  return m;
}

/** Deletes locally; a Notion copy is archived on the next sync (tombstone). */
export async function forget(st: Storage, id: string): Promise<boolean> {
  const m = await st.get<Memory>("memory", id);
  if (!m) return false;
  await st.delete("memory", id);
  if (m.notion_id) await st.put("memory_tomb", m.notion_id, { notion_id: m.notion_id });
  return true;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// ---------------------------------------------------------------- group buffer

export interface GroupLine { ts: string; who: string; text: string }
const BUFFER_MAX = 150;

export async function bufferGroupMessage(st: Storage, clock: Clock, chatId: number, who: string, text: string): Promise<void> {
  const key = String(chatId);
  const buf = (await st.get<{ lines: GroupLine[] }>("gbuf", key))?.lines || [];
  buf.push({ ts: msk(clock()).iso, who, text: text.slice(0, 600) });
  await st.put("gbuf", key, { lines: buf.slice(-BUFFER_MAX) });
}

export async function takeGroupBuffer(st: Storage, chatId: number): Promise<GroupLine[]> {
  const lines = (await st.get<{ lines: GroupLine[] }>("gbuf", String(chatId)))?.lines || [];
  await st.delete("gbuf", String(chatId));
  return lines;
}

export async function groupBufferSize(st: Storage, chatId: number): Promise<number> {
  return ((await st.get<{ lines: GroupLine[] }>("gbuf", String(chatId)))?.lines || []).length;
}
