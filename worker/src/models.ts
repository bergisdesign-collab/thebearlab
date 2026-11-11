// Domain models. Plain JSON objects; dates are ISO strings "YYYY-MM-DD".

export const STAGES = [
  "1. Концепция игры",
  "2. Поиск концепта",
  "3. Маркетинг",
  "4. Производство",
  "5. Логистика",
  "6. Приложение",
];
export const STATUSES = ["Не начато", "В работе", "На проверке", "Готово"];
export const DONE = "Готово";
export const PRIORITIES: Record<string, number> = { "Высокий": 3, "Средний": 2, "Низкий": 1 };
export const TYPES = ["Задача", "Решение", "Риск"];

// Task fields mirrored to Notion. Bot edits mark them dirty.
export const PUSHABLE = [
  "title", "stage", "type", "status", "priority", "start", "due",
  "description", "result", "assignee_notion", "log", "milestones", "depends_on",
];

export interface Task {
  id: string;                    // Notion page id (32 hex) or "local-…" until synced
  title: string;
  stage: string;
  type: string;
  status: string;
  priority: string;
  start: string | null;
  due: string | null;            // end of range or single date
  description: string;
  result: string;
  milestones: string[];          // milestone ids
  depends_on: string[];          // task ids
  assignee_tg: number | null;
  assignee_notion: string | null;
  co_tg: number[];               // partners: «делаем вместе»
  co_notion: string[];           // the other people in Notion «Исполнитель»
  log: string;
  notion_id: string | null;
  notion_edited: string;
  dirty: string[];               // fields to push to Notion
  rev: number;
  archived: boolean;
}

export function newTask(p: Partial<Task> & { id: string; title: string }): Task {
  return {
    stage: "", type: "Задача", status: "Не начато", priority: "Средний", start: null, due: null,
    description: "", result: "", milestones: [], depends_on: [], assignee_tg: null,
    assignee_notion: null, co_tg: [], co_notion: [], log: "", notion_id: null, notion_edited: "", dirty: [], rev: 0,
    archived: false, ...p,
  };
}

export function markTask(t: Task, ...names: string[]): void {
  for (const n of names) if (PUSHABLE.includes(n) && !t.dirty.includes(n)) t.dirty.push(n);
  t.rev += 1;
}

export const isDone = (t: Task): boolean => t.status === DONE;
export const shortId = (id: string): string => id.replace(/-/g, "").slice(-6);

export interface Milestone {
  id: string;
  title: string;
  date: string | null;
  status: string;
  criterion: string;
  dirty: string[];
  rev: number;
}

export function newMilestone(p: Partial<Milestone> & { id: string; title: string }): Milestone {
  return { date: null, status: "Впереди", criterion: "", dirty: [], rev: 0, ...p };
}

export interface Idea {
  id: string;
  title: string;
  group: string;
  queue: string;
  status: string;
  description: string;
  closes: string;
  tasks: string[];
  dirty: string[];
  rev: number;
}

export function newIdea(p: Partial<Idea> & { id: string; title: string }): Idea {
  return { group: "", queue: "", status: "Новая", description: "", closes: "", tasks: [], dirty: [], rev: 0, ...p };
}

export interface Member {
  tg_id: number;
  name: string;
  username: string;
  notion_user_id: string | null;
  approved: boolean;
  admin: boolean;
}

export interface Event {
  id: string;
  ts: string;      // ISO datetime, Moscow time
  task_id: string;
  actor: string;
  kind: string;    // take, release, assign, status, done, due, result, note, create
  text: string;
}

export function addDirty(o: { dirty: string[]; rev: number }, ...names: string[]): void {
  for (const n of names) if (!o.dirty.includes(n)) o.dirty.push(n);
  o.rev += 1;
}
