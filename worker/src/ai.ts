// AI consultant: Claude with tools that are the bot's own actions, team memory and dialogue memory in D1.
//   Haiku 5.5 — everyday questions and commands («перенеси ткань на пятницу и отдай Ане»)
//   Opus 5.5  — weekly deep review of the roadmap
// Every change goes through Service, so history, «Журнал», Notion sync and notifications work as with buttons.
import { daysBetween, msk } from "./config.ts";
import type { Clock } from "./config.ts";
import type { App, Btn, Notice, Result } from "./app.ts";
import * as logic from "./logic.ts";
import { PRIORITIES, STAGES, STATUSES, isDone, shortId } from "./models.ts";
import type { Member, Task } from "./models.ts";
import type { FetchFn } from "./notion.ts";
import { ActionError } from "./service.ts";
import type { Storage } from "./storage.ts";
import { esc } from "./texts.ts";

export const MODEL_FAST = "claude-haiku-5-5";
export const MODEL_DEEP = "claude-opus-5-5";
const MAX_STEPS = 6;
const HISTORY = 16;          // dialogue turns kept per person
const MAX_TASKS_IN_CONTEXT = 150;

// ---------------------------------------------------------------- Anthropic API

export interface LlmApi {
  calls: number;
  messages(body: Record<string, unknown>): Promise<any>;
}

export class AnthropicClient implements LlmApi {
  calls = 0;
  private key: string;
  private fetchFn: FetchFn;

  constructor(key: string, fetchFn: FetchFn = (i, init) => fetch(i, init)) {
    this.key = key;
    this.fetchFn = fetchFn;
  }

  async messages(body: Record<string, unknown>): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.calls += 1;
      const r = await this.fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": this.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.status === 429 || r.status === 529 || r.status >= 500) {
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
        continue;
      }
      const data: any = await r.json();
      if (r.status >= 400) throw new Error(`Anthropic ${r.status}: ${data?.error?.message || JSON.stringify(data).slice(0, 300)}`);
      return data;
    }
    throw new Error("Anthropic: перегружен, попробуй ещё раз через минуту");
  }
}

// ---------------------------------------------------------------- speech to text
// Default: Cloudflare Workers AI Whisper (free daily allocation, no extra key). Fallback: OpenAI.

export interface WorkersAi { run(model: string, input: Record<string, unknown>): Promise<any> }

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function transcribeCloudflare(audio: ArrayBuffer, ai: WorkersAi): Promise<string> {
  const r = await ai.run("@cf/openai/whisper-large-v3-turbo", { audio: toBase64(audio), language: "ru" });
  return String(r?.text || "").trim();
}

export async function transcribe(audio: ArrayBuffer, openaiKey: string, fetchFn: FetchFn = (i, init) => fetch(i, init)): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/ogg" }), "voice.ogg");
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("language", "ru");
  const r = await fetchFn("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${openaiKey}` }, body: form,
  });
  const data: any = await r.json();
  if (r.status >= 400) throw new Error(`OpenAI ${r.status}: ${data?.error?.message || ""}`);
  return String(data.text || "").trim();
}

// ---------------------------------------------------------------- tools

const S = (description: string, properties: Record<string, unknown> = {}, required: string[] = []) =>
  ({ description, input_schema: { type: "object", properties, required } });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const TASK = str("Задача: короткий код (6 символов из списка), id или название");

export const TOOLS: Record<string, ReturnType<typeof S>> = {
  find_tasks: S("Найти задачи по фильтрам. Возвращает короткие коды для других инструментов.", {
    query: str("Слова из названия/описания"),
    assignee: str("me | free | any | имя участника"),
    status: str("Статус", { enum: STATUSES }),
    stage: str("Этап", { enum: STAGES }),
    overdue: { type: "boolean", description: "Только просроченные" },
    include_done: { type: "boolean", description: "Включать выполненные" },
  }),
  get_task: S("Подробности задачи: описание, зависимости, история.", { task: TASK }, ["task"]),
  roadmap_overview: S("Сводка: прогресс, вехи и их риски, просрочки, ближайшие сроки, загрузка команды."),
  suggest_next: S("Что делать дальше: задачи по приоритету, срокам, вехам и зависимостям, с причинами.", { member: str("me | имя участника | free") }),
  take_task: S("Взять задачу на себя (на того, кто пишет).", { task: TASK }, ["task"]),
  assign_task: S("Назначить задачу участнику или освободить её.", { task: TASK, member: str("Имя участника, me или nobody") }, ["task", "member"]),
  set_status: S("Сменить статус задачи.", { task: TASK, status: str("Новый статус", { enum: STATUSES }) }, ["task", "status"]),
  set_due: S("Установить срок задачи или убрать его.", { task: TASK, date: str("YYYY-MM-DD или пустая строка, чтобы убрать срок") }, ["task", "date"]),
  set_result: S("Записать результат (ссылку или текст); задача уйдёт «На проверке».", { task: TASK, result: str("Ссылка или описание") }, ["task", "result"]),
  add_note: S("Добавить заметку в журнал задачи.", { task: TASK, text: str("Текст заметки") }, ["task", "text"]),
  create_task: S("Создать новую задачу.", {
    title: str("Название"), stage: str("Этап", { enum: STAGES }), priority: str("Приоритет", { enum: Object.keys(PRIORITIES) }),
    due: str("Срок YYYY-MM-DD (необязательно)"), description: str("Описание (необязательно)"),
    type: str("Тип", { enum: ["Задача", "Решение", "Риск"] }),
  }, ["title", "stage"]),
  promote_idea: S("Превратить идею из бэклога в задачу.", { idea: str("Название идеи"), stage: str("Этап", { enum: STAGES }) }, ["idea", "stage"]),
  list_ideas: S("Идеи из бэклога.", { queue: str("MVP | v2 | Позже"), query: str("Слова для поиска") }),
  remember: S("Сохранить в память команды важный факт: решение, договорённость, предпочтение. Используй, когда в разговоре звучит решение.", { fact: str("Факт одной фразой") }, ["fact"]),
  forget: S("Удалить факт из памяти команды.", { id: str("id факта из памяти") }, ["id"]),
  list_members: S("Участники команды и их загрузка."),
};

const SYSTEM = `Ты — ИИ-консультант команды TheBearLab в Telegram-боте «the Bear Lab Bot». TheBearLab — платформа, где дети и родители собирают плюшевого мишку в 3D-конструкторе и заказывают пошив. Команда маленькая (2–3 человека), цель — запуск продаж по роадмапу.

Что ты делаешь:
- отвечаешь на вопросы по роадмапу, задачам, срокам и рискам, опираясь на данные ниже и инструменты;
- выполняешь просьбы своими инструментами: взять, назначить, перенести срок, сменить статус, создать задачу, записать результат или заметку;
- помогаешь распределять работу: учитывай загрузку, сроки, вехи, зависимости;
- замечаешь решения и договорённости и сохраняешь их инструментом remember.

Правила:
- Отвечай по-русски, коротко и по делу; без воды и без эмодзи-салюта.
- Перед изменением убедись, что понял, о какой задаче речь. Если подходят несколько — спроси, перечислив варианты; ничего не меняй наугад.
- Не выдумывай задачи, даты и людей — бери их из данных и инструментов.
- Массовые изменения (больше 3 задач за раз) сначала опиши и спроси подтверждение.
- После изменений кратко перечисли, что сделано. Уведомления команде и запись в Notion бот делает сам.
- Даты в ответах пиши как 13.11; в инструментах — YYYY-MM-DD. Сегодня и часовой пояс (МСК) указаны в контексте.`;

// ---------------------------------------------------------------- assistant

interface Turn { role: "user" | "assistant"; content: string }

export class Assistant {
  app: App;
  st: Storage;
  llm: LlmApi;
  clock: Clock;
  notices: Notice[] = [];
  changed = new Set<string>();

  constructor(app: App, llm: LlmApi, clock: Clock) {
    this.app = app;
    this.st = app.st;
    this.llm = llm;
    this.clock = clock;
  }

  today(): string { return msk(this.clock()).date; }

  // --- context ---------------------------------------------------------------
  async context(m: Member): Promise<string> {
    const today = this.today();
    const tasks = await this.st.tasks();
    const members = (await this.st.members()).filter((x) => x.approved);
    const names = new Map(members.map((x) => [x.tg_id, x.name]));
    const notion = new Map((await this.st.notionUsers()).map((u) => [u.id, u.name]));
    const who = (t: Task) => (t.assignee_tg ? names.get(t.assignee_tg) || "?" : t.assignee_notion ? notion.get(t.assignee_notion) || "Notion" : "свободна");
    const [done, total, pct] = logic.progress(tasks);
    const lines = [
      `Сегодня ${today} (${["пн", "вт", "ср", "чт", "пт", "сб", "вс"][msk(this.clock()).weekday]}), время МСК ${msk(this.clock()).iso.slice(11, 16)}.`,
      `Пишет: ${m.name}${m.admin ? " (администратор)" : ""}.`,
      `Команда: ${members.map((x) => x.name).join(", ")}.`,
      `Прогресс: ${done}/${total} (${pct}%). До запуска продаж: ${logic.daysToLaunch(await this.st.milestones(), today)} дн.`,
      "", "Вехи (название | дата | статус | готово):",
    ];
    for (const ms of await this.st.milestones()) {
      const linked = logic.milestoneTasks(ms, tasks);
      lines.push(`- ${ms.title} | ${ms.date || "—"} | ${ms.status} | ${linked.filter(isDone).length}/${linked.length}`);
    }
    lines.push("", "Открытые задачи (код | название | этап | статус | срок | приоритет | исполнитель):");
    const open = tasks.filter((t) => !isDone(t)).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999")).slice(0, MAX_TASKS_IN_CONTEXT);
    for (const t of open) lines.push(`- ${shortId(t.id)} | ${t.title} | ${t.stage} | ${t.status} | ${t.due || "—"} | ${t.priority} | ${who(t)}`);
    const mem = await this.st.all<{ id: string; text: string; by: string; ts: string }>("memory");
    if (mem.length) {
      lines.push("", "Память команды (решения и договорённости):");
      for (const f of mem.sort((a, b) => a.ts.localeCompare(b.ts)).slice(-60)) lines.push(`- [${f.id}] ${f.ts.slice(0, 10)} ${f.by}: ${f.text}`);
    }
    return lines.join("\n");
  }

  // --- task resolution --------------------------------------------------------
  private async resolveTask(ref: string): Promise<Task> {
    ref = (ref || "").trim();
    const tasks = await this.st.tasks();
    const exact = tasks.find((t) => t.id === ref || shortId(t.id) === ref.toLowerCase().replace(/-/g, ""));
    if (exact) return exact;
    const byTitle = tasks.filter((t) => t.title.toLowerCase() === ref.toLowerCase());
    if (byTitle.length === 1) return byTitle[0];
    const hits = logic.search(ref, tasks, []).filter((h) => h.kind === "task").map((h) => h.obj as Task);
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new ActionError(`Задача «${ref}» не найдена`);
    throw new ActionError(`Под «${ref}» подходят несколько задач: ${hits.slice(0, 5).map((t) => `${shortId(t.id)} «${t.title}»`).join(", ")}. Уточни у пользователя.`);
  }

  private async resolveMember(m: Member, name: string): Promise<Member | null> {
    const n = (name || "").trim().toLowerCase().replace(/^@/, "");
    if (["me", "я", "мне", "себе"].includes(n)) return m;
    if (["nobody", "никто", "никому", ""].includes(n)) return null;
    const members = (await this.st.members()).filter((x) => x.approved);
    const found = members.filter((x) => x.name.toLowerCase().startsWith(n.slice(0, Math.max(3, n.length - 2))) || x.username.toLowerCase() === n);
    if (found.length === 1) return found[0];
    throw new ActionError(found.length ? `Несколько участников подходят под «${name}»` : `Участник «${name}» не найден. Команда: ${members.map((x) => x.name).join(", ")}`);
  }

  private brief(t: Task, names: Map<number, string>) {
    return { code: shortId(t.id), title: t.title, stage: t.stage, status: t.status, due: t.due, priority: t.priority, type: t.type,
      assignee: t.assignee_tg ? names.get(t.assignee_tg) || "?" : t.assignee_notion ? "участник Notion" : null };
  }

  private async afterChange(m: Member, t: Task, prev: number | null): Promise<void> {
    this.changed.add(t.id);
    this.notices.push(...(await this.app.noticesFor(m, t, prev)));
  }

  // --- tool execution -----------------------------------------------------------
  async runTool(m: Member, name: string, input: any): Promise<unknown> {
    const svc = this.app.svc;
    const today = this.today();
    const names = new Map((await this.st.members()).map((x) => [x.tg_id, x.name]));
    switch (name) {
      case "find_tasks": {
        let ts = await this.st.tasks();
        if (!input.include_done) ts = ts.filter((t) => !isDone(t));
        if (input.query) {
          const hits = new Set(logic.search(input.query, ts, [], 50).map((h) => h.obj.id));
          ts = ts.filter((t) => hits.has(t.id));
        }
        if (input.status) ts = ts.filter((t) => t.status === input.status);
        if (input.stage) ts = ts.filter((t) => t.stage === input.stage);
        if (input.overdue) ts = logic.overdue(ts, today);
        const a = (input.assignee || "any").toLowerCase();
        if (a === "me") ts = ts.filter((t) => t.assignee_tg === m.tg_id);
        else if (a === "free") ts = ts.filter(logic.isFree);
        else if (a !== "any") {
          const who = await this.resolveMember(m, a);
          ts = ts.filter((t) => (who ? t.assignee_tg === who.tg_id : logic.isFree(t)));
        }
        return { count: ts.length, tasks: ts.slice(0, 30).map((t) => this.brief(t, names)) };
      }
      case "get_task": {
        const t = await this.resolveTask(input.task);
        const all = await this.st.tasks();
        const byId = new Map(all.map((x) => [x.id, x]));
        const evs = await this.st.events("", t.id);
        return {
          ...this.brief(t, names), description: t.description.slice(0, 1500), result: t.result,
          depends_on: t.depends_on.map((d) => byId.get(d)).filter(Boolean).map((x) => ({ code: shortId(x!.id), title: x!.title, done: isDone(x!) })),
          blocks: logic.blockedTasks(t, all).map((x) => x.title),
          history: evs.slice(-10).map((e) => `${e.ts.slice(0, 16)} ${e.actor}: ${e.text}`),
          journal: evs.length ? undefined : t.log.slice(-800),
        };
      }
      case "roadmap_overview": {
        const tasks = await this.st.tasks();
        const load: Record<string, number> = {};
        for (const t of tasks) if (!isDone(t) && t.assignee_tg) load[names.get(t.assignee_tg) || "?"] = (load[names.get(t.assignee_tg) || "?"] || 0) + 1;
        return {
          progress: logic.progress(tasks), days_to_launch: logic.daysToLaunch(await this.st.milestones(), today),
          streak: logic.streak(await this.st.days(), today),
          milestones: (await this.st.milestones()).map((x) => ({ title: x.title, date: x.date, status: logic.milestoneStatus(x, tasks, today) })),
          overdue: logic.overdue(tasks, today).map((t) => this.brief(t, names)),
          due_7_days: logic.dueWithin(tasks, today, 7).map((t) => this.brief(t, names)),
          open_tasks_per_person: load,
        };
      }
      case "suggest_next": {
        const who = input.member === "free" ? null : input.member ? await this.resolveMember(m, input.member) : m;
        const sug = logic.suggest(await this.st.tasks(), await this.st.milestones(), who ? who.tg_id : null, today, 5);
        return sug.map((s) => ({ ...this.brief(s.task, names), score: s.score, reasons: s.reasons }));
      }
      case "take_task": {
        const t = await this.resolveTask(input.task);
        const prev = t.assignee_tg;
        await svc.take(t, m);
        await this.afterChange(m, t, prev);
        return { ok: true, task: this.brief(t, names) };
      }
      case "assign_task": {
        const t = await this.resolveTask(input.task);
        const prev = t.assignee_tg;
        const target = await this.resolveMember(m, input.member);
        if (target) await svc.assign(t, m, target);
        else await svc.release(t, m);
        await this.afterChange(m, t, prev);
        return { ok: true, task: this.brief(t, names) };
      }
      case "set_status": {
        const t = await this.resolveTask(input.task);
        const prev = t.assignee_tg;
        await svc.setStatus(t, m, input.status);
        await this.afterChange(m, t, prev);
        return { ok: true, task: this.brief(t, names) };
      }
      case "set_due": {
        const t = await this.resolveTask(input.task);
        const prev = t.assignee_tg;
        const d = input.date ? logic.parseDate(String(input.date), today) : null;
        if (input.date && !d) throw new ActionError(`Не понял дату «${input.date}», нужен формат YYYY-MM-DD`);
        await svc.setDue(t, m, d);
        await this.afterChange(m, t, prev);
        return { ok: true, task: this.brief(t, names), note: d && daysBetween(today, d) < 0 ? "дата в прошлом" : undefined };
      }
      case "set_result": {
        const t = await this.resolveTask(input.task);
        const prev = t.assignee_tg;
        await svc.setResult(t, m, String(input.result));
        await this.afterChange(m, t, prev);
        return { ok: true, task: this.brief(t, names) };
      }
      case "add_note": {
        const t = await this.resolveTask(input.task);
        await svc.note(t, m, String(input.text));
        this.app.svc.recent = [];
        return { ok: true };
      }
      case "create_task": {
        const stage = STAGES.includes(input.stage) ? input.stage : STAGES[0];
        const due = input.due ? logic.parseDate(String(input.due), today) : null;
        const t = await svc.create(m, String(input.title), stage, input.priority in PRIORITIES ? input.priority : "Средний", due,
          ["Задача", "Решение", "Риск"].includes(input.type) ? input.type : "Задача", String(input.description || ""));
        await this.afterChange(m, t, null);
        return { ok: true, task: this.brief(t, names) };
      }
      case "promote_idea": {
        const ideas = await this.st.ideas();
        const q = String(input.idea || "").toLowerCase();
        const hits = ideas.filter((i) => i.title.toLowerCase().includes(q) || logic.search(q, [], [i]).length);
        if (hits.length !== 1) throw new ActionError(hits.length ? `Подходят идеи: ${hits.slice(0, 5).map((i) => i.title).join(", ")}` : `Идея «${input.idea}» не найдена`);
        if (hits[0].status !== "Новая") throw new ActionError(`Идея уже в статусе «${hits[0].status}»`);
        const t = await svc.promoteIdea(hits[0], m, STAGES.includes(input.stage) ? input.stage : STAGES[0]);
        await this.afterChange(m, t, null);
        return { ok: true, task: this.brief(t, names) };
      }
      case "list_ideas": {
        let ideas = await this.st.ideas();
        if (input.queue) ideas = ideas.filter((i) => i.queue === input.queue);
        if (input.query) {
          const hits = new Set(logic.search(input.query, [], ideas, 30).map((h) => h.obj.id));
          ideas = ideas.filter((i) => hits.has(i.id));
        }
        return ideas.slice(0, 40).map((i) => ({ title: i.title, group: i.group, queue: i.queue, status: i.status, closes: i.closes.slice(0, 200) }));
      }
      case "remember": {
        const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
        await this.st.put("memory", id, { id, text: String(input.fact).slice(0, 500), by: m.name, ts: msk(this.clock()).iso });
        return { ok: true, id };
      }
      case "forget": {
        await this.st.delete("memory", String(input.id));
        return { ok: true };
      }
      case "list_members": {
        const tasks = await this.st.tasks();
        return (await this.st.members()).filter((x) => x.approved).map((x) => ({
          name: x.name, admin: x.admin,
          open: tasks.filter((t) => t.assignee_tg === x.tg_id && !isDone(t)).length,
          overdue: logic.overdue(tasks.filter((t) => t.assignee_tg === x.tg_id), today).length,
        }));
      }
    }
    throw new ActionError(`Неизвестный инструмент ${name}`);
  }

  // --- dialogue -------------------------------------------------------------------
  async ask(m: Member, text: string): Promise<Result> {
    this.notices = [];
    this.changed.clear();
    const hist = ((await this.st.get<{ turns: Turn[] }>("chat", String(m.tg_id)))?.turns || []).slice(-HISTORY);
    const messages: any[] = hist.map((t) => ({ role: t.role, content: t.content }));
    messages.push({ role: "user", content: text });
    const tools = Object.entries(TOOLS).map(([name, def]) => ({ name, ...def }));
    const system = [
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
      { type: "text", text: await this.context(m) },
    ];
    let answer = "";
    for (let step = 0; step < MAX_STEPS; step++) {
      const t0 = Date.now();
      const resp = await this.llm.messages({ model: MODEL_FAST, max_tokens: 1500, system, tools, messages });
      console.log("ai step", step, resp.stop_reason, `${Date.now() - t0}ms`, (resp.content || []).map((b: any) => b.type === "tool_use" ? `tool:${b.name}` : b.type).join(","));
      const content: any[] = resp.content || [];
      const texts = content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      const uses = content.filter((b) => b.type === "tool_use");
      if (resp.stop_reason !== "tool_use" || !uses.length) { answer = texts; break; }
      messages.push({ role: "assistant", content });
      const results: any[] = [];
      for (const u of uses) {
        try {
          results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(await this.runTool(m, u.name, u.input || {})) });
        } catch (e) {
          const msg = e instanceof ActionError ? e.message : `Ошибка: ${String(e).slice(0, 200)}`;
          results.push({ type: "tool_result", tool_use_id: u.id, content: msg, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
      if (step === MAX_STEPS - 1) answer = texts || "Сделал, что успел. Уточни, если нужно что-то ещё.";
    }
    answer = answer || "Готово.";
    const turns = [...hist, { role: "user" as const, content: text }, { role: "assistant" as const, content: answer }].slice(-HISTORY);
    await this.st.put("chat", String(m.tg_id), { turns });
    const kb: Btn[][] = [...this.changed].slice(0, 5).map((id) => [{ text: "Открыть задачу", data: `t:v:${id}` }]);
    kb.push([{ text: "Меню", data: "go:menu" }]);
    return { screen: { text: esc(answer), kb }, notices: this.notices };
  }

  /** Weekly deep review by Opus: where we are stuck, what to change. Plain text. */
  async weeklyReview(): Promise<string> {
    const today = this.today();
    const evs = await this.st.events(msk(new Date(this.clock().getTime() - 7 * 86400000)).date);
    const admin = (await this.st.members()).find((x) => x.admin) || { tg_id: 0, name: "команда", username: "", notion_user_id: null, approved: true, admin: true };
    const ctx = await this.context(admin);
    const week = evs.slice(-200).map((e) => `${e.ts.slice(0, 16)} ${e.actor}: ${e.text}`).join("\n");
    const resp = await this.llm.messages({
      model: MODEL_DEEP, max_tokens: 1200,
      system: SYSTEM + "\n\nСейчас твоя задача — недельный разбор для всей команды.",
      messages: [{ role: "user", content: `${ctx}\n\nСобытия за неделю:\n${week || "нет"}\n\nСделай разбор на ${today}: 1) что продвинулось, 2) где застреваем и почему (переносы, просрочки, перегрузка), 3) риски для ближайших вех, 4) 3–5 конкретных рекомендаций на следующую неделю с именами. Коротко, списками, без вступлений.` }],
    });
    return (resp.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
  }
}
