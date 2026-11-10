// Bot brain, independent of Telegram transport.
// Input: commands, callback data, free text. Output: Result (screen to show + notices to send).
import { addDays, isAdminListed, msk, notionUrl } from "./config.ts";
import type { Clock } from "./config.ts";
import * as logic from "./logic.ts";
import { PRIORITIES, STAGES, STATUSES, isDone } from "./models.ts";
import type { Member, Task } from "./models.ts";
import { ActionError, Service } from "./service.ts";
import type { Storage } from "./storage.ts";
import * as texts from "./texts.ts";
import { esc } from "./texts.ts";

export interface Btn { text: string; data?: string; url?: string }
export interface Screen { text: string; kb: Btn[][] }
export interface Notice { chatId: number; text: string; kb: Btn[][] }
export interface Result { screen?: Screen; notices: Notice[]; toast?: string; alert?: boolean; newMessage?: boolean }
export interface Who { id: number; name: string; username?: string }

const B = (text: string, data: string): Btn => ({ text, data });
const U = (text: string, url: string): Btn => ({ text, url });
const S = (text: string, kb: Btn[][] = []): Screen => ({ text, kb });
const R = (screen?: Screen, extra: Partial<Result> = {}): Result => ({ screen, notices: [], ...extra });

const STATUS_BTN: Record<string, string> = { "Не начато": "⚪ Не начато", "В работе": "🔵 В работу", "На проверке": "🟡 На проверку", "Готово": "✅ Готово" };
const BROADCAST_ICON: Record<string, string> = { take: "🙋", release: "↩️", assign: "👥", done: "✅", status: "🔄", due: "📅", create: "➕", result: "🔗" };

export const MENU: Btn[][] = [
  [B("Сводка", "go:today"), B("Мои", "go:my"), B("Что дальше", "go:next")],
  [B("Свободные", "go:free"), B("Этапы", "go:tasks"), B("Роадмап", "go:plan")],
  [B("Идеи", "go:ideas"), B("Новая задача", "go:new"), B("Команда", "go:team")],
];

export type AskFn = (m: Member, text: string) => Promise<Result>;
export interface AppOptions { adminIds?: Set<string>; syncFn?: () => Promise<string>; askFn?: AskFn }

export class App {
  st: Storage;
  clock: Clock;
  svc: Service;
  adminIds: Set<string>;
  syncFn?: () => Promise<string>;
  askFn?: AskFn;      // AI consultant; when absent, free text is a search

  constructor(st: Storage, clock: Clock, opts: AppOptions = {}) {
    this.st = st;
    this.clock = clock;
    this.svc = new Service(st, clock);
    this.adminIds = opts.adminIds || new Set();
    this.syncFn = opts.syncFn;
    this.askFn = opts.askFn;
  }

  /** Approved member for this Telegram user, or null. */
  async memberOf(who: Who): Promise<Member | null> { return this.member(who); }

  today(): string { return msk(this.clock()).date; }

  // =========================================================================
  // membership
  // =========================================================================
  private async member(who: Who): Promise<Member | null> {
    const m = await this.st.member(who.id);
    if (!m || !m.approved) return null;
    if ((who.username || "") !== m.username) {
      m.username = who.username || "";
      await this.st.saveMember(m);
    }
    return m;
  }

  async start(who: Who): Promise<Result> {
    let m = await this.st.member(who.id);
    if (m && m.approved) return R(S(`С возвращением, ${esc(m.name)}!\n\n${texts.HELP}`, MENU));
    const approved = (await this.st.members()).filter((x) => x.approved);
    if (!approved.length || isAdminListed(this.adminIds, who.id, who.username)) {
      m = { tg_id: who.id, name: who.name, username: who.username || "", notion_user_id: m?.notion_user_id ?? null, approved: true, admin: true };
      await this.st.saveMember(m);
      return R(S(`Привет, ${esc(who.name)}! Ты администратор команды.\n\n`
        + "Дальше: добавь бота в общий чат и отправь там /bindchat, а партнёрам дай ссылку на бота — их заявки придут тебе.\n"
        + "В /team привяжи себя к пользователю Notion, чтобы назначения попадали в Notion.\n\n" + texts.HELP, MENU));
    }
    if (!m) {
      m = { tg_id: who.id, name: who.name, username: who.username || "", notion_user_id: null, approved: false, admin: false };
      await this.st.saveMember(m);
    }
    const uname = who.username ? ` (@${esc(who.username)})` : "";
    const notices: Notice[] = approved.filter((a) => a.admin).map((a) => ({
      chatId: a.tg_id, text: `Заявка в команду: <b>${esc(who.name)}</b>${uname}`,
      kb: [[B("✅ Принять", `m:ok:${who.id}`), B("✖️ Отклонить", `m:no:${who.id}`)]],
    }));
    return R(S("Заявка отправлена администратору. Как только её примут, я пришлю сообщение."), { notices });
  }

  // =========================================================================
  // entry points
  // =========================================================================
  async onCommand(who: Who, chatId: number, isPrivate: boolean, cmd: string, args = ""): Promise<Result> {
    this.svc.recent = [];
    cmd = cmd.toLowerCase().split("@")[0];
    if (cmd === "start") return this.start(who);
    const m = await this.member(who);
    if (!m) return R(S("Сначала отправь мне /start в личных сообщениях — я передам заявку администратору."));
    await this.st.kvDel(`await:${m.tg_id}`);
    args = (args || "").trim();
    switch (cmd) {
      case "bindchat":
        if (isPrivate) return R(S("Отправь /bindchat в общем чате команды — туда будут приходить сводки."));
        if (!m.admin) return R(S("Привязать чат может только администратор."));
        await this.st.kvSet("group_chat", chatId);
        return R(S("Готово! Сюда будут приходить: сводка в 09:00, вечерняя сверка в 18:00, итоги недели в пятницу и все взятия/снятия/закрытия задач."));
      case "unbindchat":
        if (!m.admin) return R(S("Отвязать чат может только администратор."));
        await this.st.kvDel("group_chat");
        return R(S("Чат отвязан от сводок."));
      case "digest":
      case "today":
        return R(await this.scrToday());
      case "new":
        if (args) {
          await this.st.kvSet(`await:${m.tg_id}`, { a: "new", title: args.slice(0, 200) });
          return R(this.scrNewStage(args));
        }
        await this.st.kvSet(`await:${m.tg_id}`, { a: "new_title" });
        return R(S("Как назовём задачу? Напиши одной строкой.", [[B("Отмена", "n:cancel")]]));
      case "find":
        return R(args ? await this.scrSearch(args) : S("Напиши: /find ткань — или просто слово в личку."));
      case "sync":
        return this.triggerSync();
      case "ask":
        if (!this.askFn) return R(S("ИИ-консультант пока не подключён. Пока можно искать: /find слово."));
        if (!args) return R(S("Напиши вопрос после команды: /ask что горит на этой неделе?"));
        return this.askFn(m, args);
      case "cancel":
        return R(S("Ок, отменил.", MENU));
    }
    const screens: Record<string, (m: Member) => Promise<Screen>> = {
      menu: (x) => this.scrMenu(x), my: (x) => this.scrMy(x), next: (x) => this.scrNext(x), free: () => this.scrFree(),
      tasks: () => this.scrStages(), plan: () => this.scrPlan(), milestones: () => this.scrMilestones(),
      ideas: () => this.scrIdeas(), team: (x) => this.scrTeam(x), help: () => this.scrHelp(),
    };
    const fn = screens[cmd];
    return fn ? R(await fn(m)) : R(S("Не знаю такой команды. /help — список."));
  }

  async onText(who: Who, chatId: number, isPrivate: boolean, text: string): Promise<Result | null> {
    this.svc.recent = [];
    if (!isPrivate) return null;
    const m = await this.member(who);
    if (!m) return R(S("Отправь /start, чтобы попасть в команду."));
    text = (text || "").trim();
    const aw = await this.st.kvGet<Record<string, string>>(`await:${m.tg_id}`);
    if (aw) return this.onAwait(m, aw, text);
    if (this.askFn) return this.askFn(m, text);
    return R(await this.scrSearch(text));
  }

  async onCallback(who: Who, chatId: number, data: string): Promise<Result> {
    this.svc.recent = [];
    const m = await this.member(who);
    if (!m) return R(undefined, { toast: "Ты ещё не в команде — отправь /start боту в личку", alert: true });
    const p = data.split(":");
    try {
      switch (p[0]) {
        case "go": return await this.go(m, p[1]);
        case "t": return await this.taskCb(m, p);
        case "s": return R(await this.scrStage(Number(p[1]), p[2] === "all"));
        case "ms": return R(await this.scrMilestone(p[2]));
        case "iq": return R(await this.scrIdeaQueue(p[1]));
        case "i": return await this.ideaCb(m, p);
        case "n": return await this.newCb(m, p);
        case "m": return await this.memberCb(m, p);
      }
    } catch (e) {
      if (e instanceof ActionError) return R(undefined, { toast: e.message, alert: true });
      throw e;
    }
    return R(undefined, { toast: "Кнопка устарела — открой заново через /menu" });
  }

  // =========================================================================
  // screens
  // =========================================================================
  private async go(m: Member, where: string): Promise<Result> {
    if (where === "new") {
      await this.st.kvSet(`await:${m.tg_id}`, { a: "new_title" });
      return R(S("Как назовём задачу? Напиши одной строкой.", [[B("Отмена", "n:cancel")]]));
    }
    const fns: Record<string, () => Promise<Screen>> = {
      today: () => this.scrToday(), my: () => this.scrMy(m), next: () => this.scrNext(m), free: () => this.scrFree(),
      tasks: () => this.scrStages(), plan: () => this.scrPlan(), ms: () => this.scrMilestones(),
      ideas: () => this.scrIdeas(), team: () => this.scrTeam(m), help: () => this.scrHelp(), menu: () => this.scrMenu(m),
    };
    const fn = fns[where];
    return fn ? R(await fn()) : R(undefined, { toast: "Кнопка устарела — открой заново через /menu" });
  }

  async scrMenu(_m?: Member): Promise<Screen> {
    return S("<b>the Bear Lab Bot</b>\n\n" + (await texts.headerStats(this.st, this.today())).join("\n"), MENU);
  }

  async scrHelp(): Promise<Screen> {
    const last = await this.st.kvGet<string>("last_sync");
    const tail = last ? `\n\n<i>Последняя синхронизация с Notion: ${last.slice(8, 10)}.${last.slice(5, 7)} ${last.slice(11, 16)} МСК</i>` : "";
    return S(texts.HELP + tail, MENU);
  }

  async scrToday(): Promise<Screen> {
    return S(await texts.teamDigest(this.st, this.today()), [[B("Мои задачи", "go:my"), B("Что дальше", "go:next")], [B("Меню", "go:menu")]]);
  }

  private taskButtons(tasks: Task[]): Btn[][] {
    const today = this.today();
    return tasks.map((t) => [B(texts.buttonLabel(t, today), `t:v:${t.id}`)]);
  }

  async scrMy(m: Member): Promise<Screen> {
    const today = this.today();
    const mine = (await this.st.tasks()).filter((t) => t.assignee_tg === m.tg_id && !isDone(t));
    mine.sort((a, b) => Number(a.status !== "В работе") - Number(b.status !== "В работе") || (a.due || "9999").localeCompare(b.due || "9999"));
    if (!mine.length) return S("На тебе нет открытых задач. Посмотри /free или /next.", [[B("Свободные", "go:free"), B("Что дальше", "go:next")]]);
    const od = logic.overdue(mine, today).length;
    return S(`<b>Мои задачи (${mine.length})</b>` + (od ? ` · просрочено: ${od}` : ""), [...this.taskButtons(mine.slice(0, 40)), [B("Меню", "go:menu")]]);
  }

  async scrNext(m: Member): Promise<Screen> {
    const sug = logic.suggest(await this.st.tasks(), await this.st.milestones(), m.tg_id, this.today(), 3);
    if (!sug.length) return S("Все доступные задачи разобраны или ждут других задач. Загляни в /plan.", MENU);
    const lines = ["<b>Что делать дальше</b>", ""];
    const kb: Btn[][] = [];
    sug.forEach((s, i) => {
      lines.push(`${i + 1}. <b>${esc(s.task.title)}</b>`);
      if (s.reasons.length) lines.push(`   <i>${esc(s.reasons.join(", "))}</i>`);
      kb.push([B(`${i + 1}. ${texts.cut(s.task.title, 40)}`, `t:v:${s.task.id}`)]);
    });
    lines.push("", "Учитываю приоритет, сроки, близость вехи, сколько задач ждут эту и готовы ли зависимости.");
    return S(lines.join("\n"), [...kb, [B("Меню", "go:menu")]]);
  }

  async scrFree(): Promise<Screen> {
    const tasks = await this.st.tasks();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const sug = logic.suggest(tasks, await this.st.milestones(), null, this.today(), 15);
    const blocked = tasks.filter((t) => !isDone(t) && logic.isFree(t) && logic.openDeps(t, byId).length);
    if (!sug.length) return S("Свободных задач, готовых к старту, нет.", MENU);
    let text = `<b>Свободные задачи (${sug.length})</b> — по важности. Открой и нажми «Взять».`;
    if (blocked.length) text += `\n<i>Ещё ${blocked.length} ждут завершения других задач.</i>`;
    return S(text, [...this.taskButtons(sug.map((s) => s.task)), [B("Меню", "go:menu")]]);
  }

  async scrStages(): Promise<Screen> {
    const tasks = await this.st.tasks();
    const kb: Btn[][] = STAGES.map((s, i) => {
      const [d, n] = logic.progress(tasks.filter((t) => t.stage === s));
      return [B(`${s} · ${d}/${n}`, `s:${i}`)];
    });
    const other = tasks.filter((t) => !STAGES.includes(t.stage));
    if (other.length) kb.push([B(`Без этапа · ${other.length}`, `s:${STAGES.length}`)]);
    return S("<b>Задачи по этапам</b>", [...kb, [B("Меню", "go:menu")]]);
  }

  async scrStage(idx: number, showAll = false): Promise<Screen> {
    const tasks = await this.st.tasks();
    const name = idx < STAGES.length ? STAGES[idx] : "Без этапа";
    const ts = idx < STAGES.length ? tasks.filter((t) => t.stage === name) : tasks.filter((t) => !STAGES.includes(t.stage));
    ts.sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || (a.due || "9999").localeCompare(b.due || "9999")
      || (PRIORITIES[b.priority] ?? 2) - (PRIORITIES[a.priority] ?? 2));
    const [d, n, p] = logic.progress(ts);
    const kb = this.taskButtons((showAll ? ts : ts.filter((t) => !isDone(t))).slice(0, 50));
    if (!showAll && d) kb.push([B(`Показать выполненные (${d})`, `s:${idx}:all`)]);
    kb.push([B("← Этапы", "go:tasks"), B("Меню", "go:menu")]);
    return S(`<b>${esc(name)}</b>\n${logic.bar(p)} ${d}/${n}`, kb);
  }

  async scrPlan(): Promise<Screen> {
    return S(await texts.plan(this.st, this.today()), [[B("Вехи", "go:ms"), B("Этапы", "go:tasks")], [B("Меню", "go:menu")]]);
  }

  async scrMilestones(): Promise<Screen> {
    const tasks = await this.st.tasks();
    const ms = await this.st.milestones();
    const lines = ["<b>Вехи</b>", "", ...ms.map((x) => texts.milestoneLine(x, tasks, this.today()))];
    return S(lines.join("\n"), [...ms.map((x) => [B(texts.cut(x.title, 45), `ms:v:${x.id}`)]), [B("Меню", "go:menu")]]);
  }

  async scrMilestone(mid: string): Promise<Screen> {
    const x = (await this.st.milestones()).find((m) => m.id === mid);
    if (!x) return S("Веха не найдена.", MENU);
    const tasks = await this.st.tasks();
    const linked = logic.milestoneTasks(x, tasks).sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || (a.due || "9999").localeCompare(b.due || "9999"));
    let text = texts.milestoneLine(x, tasks, this.today());
    if (x.criterion) text += `\n\n<b>Критерий:</b> ${esc(x.criterion)}`;
    return S(text, [...this.taskButtons(linked.slice(0, 40)), [U("Открыть в Notion", notionUrl(x.id))], [B("← Вехи", "go:ms")]]);
  }

  async scrSearch(query: string): Promise<Screen> {
    const hits = logic.search(query, await this.st.tasks(), await this.st.ideas());
    if (!hits.length) return S(`По запросу «${esc(query)}» ничего не нашёл.`, MENU);
    const today = this.today();
    const kb = hits.map((h) => h.kind === "task"
      ? [B(texts.buttonLabel(h.obj, today), `t:v:${h.obj.id}`)]
      : [B(`💡 ${texts.cut(h.obj.title, 42)}`, `i:v:${h.obj.id}`)]);
    return S(`Нашёл по запросу «${esc(query)}»:`, [...kb, [B("Меню", "go:menu")]]);
  }

  // --- task card --------------------------------------------------------------
  async scrTask(m: Member, t: Task): Promise<Screen> {
    const evs = await this.st.events("", t.id);
    const text = await texts.taskCard(t, this.st, this.today(), evs);
    const kb: Btn[][] = [];
    const row: Btn[] = [];
    if (!isDone(t)) {
      if (t.assignee_tg === m.tg_id) row.push(B("↩️ Снять с себя", `t:rel:${t.id}`));
      else if (logic.isFree(t)) row.push(B("🙋 Взять", `t:take:${t.id}`));
      else if (m.admin) row.push(B("↩️ Освободить", `t:rel:${t.id}`));
    }
    row.push(B("👥 Назначить", `t:asg:${t.id}`));
    kb.push(row);
    const st = STATUSES.map((s, i) => [s, i] as const).filter(([s]) => s !== t.status && s !== "Не начато").map(([s, i]) => B(STATUS_BTN[s], `t:st:${t.id}:${i}`));
    kb.push(st.length ? st : [B("⚪ Вернуть в «Не начато»", `t:st:${t.id}:0`)]);
    if (!isDone(t)) kb.push([B("+1 день", `t:dd:${t.id}:1`), B("+3", `t:dd:${t.id}:3`), B("+7", `t:dd:${t.id}:7`), B("📅 Дата", `t:date:${t.id}`)]);
    kb.push([B("🔗 Результат", `t:res:${t.id}`), B("📝 Заметка", `t:note:${t.id}`), B("🕘 История", `t:log:${t.id}`)]);
    const nav: Btn[] = [];
    if (t.notion_id) nav.push(U("Notion", notionUrl(t.notion_id)));
    const idx = STAGES.includes(t.stage) ? STAGES.indexOf(t.stage) : STAGES.length;
    nav.push(B("← Этап", `s:${idx}`), B("Меню", "go:menu"));
    kb.push(nav);
    return S(text, kb);
  }

  /** Notices for the team about the events produced by the last action(s) on task t. */
  async noticesFor(m: Member, t: Task, prevOwner: number | null): Promise<Notice[]> {
    const evs = this.svc.recent.filter((e) => e.task_id === t.id);
    this.svc.recent = this.svc.recent.filter((e) => e.task_id !== t.id);
    const notices: Notice[] = [];
    const group = await this.st.kvGet<number>("group_chat");
    if (group) {
      for (const e of evs) {
        if (BROADCAST_ICON[e.kind]) {
          notices.push({ chatId: Number(group), text: `${BROADCAST_ICON[e.kind]} <b>${esc(m.name)}</b>: «${esc(t.title)}» — ${esc(e.text)}`, kb: [[B("Открыть", `t:v:${t.id}`)]] });
        }
      }
    }
    if (evs.length) {
      const summary = evs.map((e) => e.text).join("; ");
      for (const uid of new Set([prevOwner, t.assignee_tg])) {
        if (uid && uid !== m.tg_id) {
          notices.push({ chatId: uid, text: `<b>${esc(m.name)}</b> → «${esc(t.title)}»: ${esc(summary)}`, kb: [[B("Открыть", `t:v:${t.id}`)]] });
        }
      }
    }
    return notices;
  }

  private async after(m: Member, t: Task, prevOwner: number | null, toast: string): Promise<Result> {
    const notices = await this.noticesFor(m, t, prevOwner);
    this.svc.recent = [];
    return R(await this.scrTask(m, t), { notices, toast });
  }

  private async taskCb(m: Member, p: string[]): Promise<Result> {
    const act = p[1];
    const t = await this.st.task(p[2]);
    if (!t) return R(undefined, { toast: "Задача не найдена (возможно, удалена в Notion)", alert: true });
    const prev = t.assignee_tg;
    switch (act) {
      case "v": return R(await this.scrTask(m, t));
      case "take": return this.after(m, await this.svc.take(t, m), prev, "Задача твоя");
      case "rel": return this.after(m, await this.svc.release(t, m), prev, "Задача освобождена");
      case "asg": {
        const kb: Btn[][] = (await this.st.members()).filter((x) => x.approved)
          .map((x) => [B((x.tg_id === t.assignee_tg ? "✓ " : "") + x.name, `t:to:${t.id}:${x.tg_id}`)]);
        kb.push([B("Никто (освободить)", `t:rel:${t.id}`), B("← Назад", `t:v:${t.id}`)]);
        return R(S(`Кому назначить «${esc(t.title)}»?`, kb));
      }
      case "to": {
        const target = await this.st.member(Number(p[3]));
        if (!target || !target.approved) throw new ActionError("Участник не найден");
        return this.after(m, await this.svc.assign(t, m, target), prev, `Назначено: ${target.name}`);
      }
      case "st": {
        const status = STATUSES[Number(p[3])];
        if (!status) throw new ActionError("Неизвестный статус");
        return this.after(m, await this.svc.setStatus(t, m, status), prev, status);
      }
      case "dd": return this.after(m, await this.svc.postpone(t, m, Number(p[3])), prev, "Срок перенесён");
      case "date":
        await this.st.kvSet(`await:${m.tg_id}`, { a: "due", t: t.id });
        return R(S(`Новый срок для «${esc(t.title)}»? Например: 15.11, завтра, +5. Или «нет», чтобы убрать срок.`, [[B("Отмена", `t:v:${t.id}`)]]));
      case "res":
        await this.st.kvSet(`await:${m.tg_id}`, { a: "result", t: t.id });
        return R(S(`Пришли мне в личку ссылку на результат «${esc(t.title)}» (документ, макет, папка) или короткое описание.\nЗадача перейдёт в «На проверке».`, [[B("Отмена", `t:v:${t.id}`)]]));
      case "note":
        await this.st.kvSet(`await:${m.tg_id}`, { a: "note", t: t.id });
        return R(S(`Напиши мне в личку заметку для журнала «${esc(t.title)}».`, [[B("Отмена", `t:v:${t.id}`)]]));
      case "log":
        return R(S(texts.history(t, await this.st.events("", t.id)), [[B("← Назад", `t:v:${t.id}`)]]));
    }
    return R(undefined, { toast: "Неизвестное действие" });
  }

  // --- free-text inputs -----------------------------------------------------------
  private async onAwait(m: Member, aw: Record<string, string>, text: string): Promise<Result> {
    const key = `await:${m.tg_id}`;
    const a = aw.a;
    if (a === "new_title") {
      if (!text) return R(S("Название пустое — напиши ещё раз."));
      await this.st.kvSet(key, { a: "new", title: text.slice(0, 200) });
      return R(this.scrNewStage(text));
    }
    if (a === "new_due") {
      const d = logic.parseDate(text, this.today());
      if (!d) return R(S("Не понял дату. Пример: 15.11, завтра, +5."));
      return this.createFromDraft(m, aw, d);
    }
    if (a === "new") return R(S("Выбери этап кнопкой выше или отправь /cancel."));
    const t = await this.st.task(aw.t || "");
    await this.st.kvDel(key);
    if (!t) return R(S("Задача не найдена.", MENU));
    const prev = t.assignee_tg;
    if (a === "result") return this.after(m, await this.svc.setResult(t, m, text), prev, "");
    if (a === "note") return R(await this.scrTask(m, await this.svc.note(t, m, text)));
    if (a === "due") {
      if (["нет", "без срока", "-"].includes(text.toLowerCase())) return this.after(m, await this.svc.setDue(t, m, null), prev, "");
      const d = logic.parseDate(text, this.today());
      if (!d) {
        await this.st.kvSet(key, aw);
        return R(S("Не понял дату. Пример: 15.11, завтра, +5."));
      }
      return this.after(m, await this.svc.setDue(t, m, d), prev, "");
    }
    return R(S("Ок.", MENU));
  }

  // --- new task wizard -------------------------------------------------------------
  scrNewStage(title: string): Screen {
    return S(`Новая задача: <b>${esc(title)}</b>\nК какому этапу?`, [...STAGES.map((s, i) => [B(s, `n:st:${i}`)]), [B("Отмена", "n:cancel")]]);
  }

  private async newCb(m: Member, p: string[]): Promise<Result> {
    const key = `await:${m.tg_id}`;
    const draft = (await this.st.kvGet<Record<string, string>>(key)) || {};
    if (p[1] === "cancel") {
      await this.st.kvDel(key);
      return R(S("Создание задачи отменено.", MENU));
    }
    if (draft.a !== "new" && draft.a !== "new_due") return R(undefined, { toast: "Начни заново: /new", alert: true });
    if (p[1] === "st") {
      draft.stage = STAGES[Number(p[2])] || "";
      await this.st.kvSet(key, draft);
      return R(S(`<b>${esc(draft.title)}</b>\n${esc(draft.stage)}\nПриоритет?`, [Object.keys(PRIORITIES).map((x) => B(x, `n:pr:${x}`)), [B("Отмена", "n:cancel")]]));
    }
    if (p[1] === "pr") {
      draft.priority = p[2] in PRIORITIES ? p[2] : "Средний";
      await this.st.kvSet(key, draft);
      return R(S(`<b>${esc(draft.title)}</b>\n${esc(draft.stage)} · ${esc(draft.priority)}\nСрок?`, [
        [B("Без срока", "n:due:0"), B("+3 дня", "n:due:3"), B("+7", "n:due:7"), B("+14", "n:due:14")],
        [B("📅 Своя дата", "n:due:custom")], [B("Отмена", "n:cancel")]]));
    }
    if (p[1] === "due") {
      if (p[2] === "custom") {
        draft.a = "new_due";
        await this.st.kvSet(key, draft);
        return R(S("Напиши дату: 15.11, завтра или +5.", [[B("Отмена", "n:cancel")]]));
      }
      const n = Number(p[2]);
      return this.createFromDraft(m, draft, n ? addDays(this.today(), n) : null);
    }
    return R(undefined, { toast: "?" });
  }

  private async createFromDraft(m: Member, draft: Record<string, string>, due: string | null): Promise<Result> {
    await this.st.kvDel(`await:${m.tg_id}`);
    const t = await this.svc.create(m, draft.title, draft.stage || "", draft.priority || "Средний", due);
    const r = await this.after(m, t, null, "Задача создана");
    r.newMessage = true;
    return r;
  }

  // --- ideas -------------------------------------------------------------------------
  async scrIdeas(): Promise<Screen> {
    const ideas = await this.st.ideas();
    const lines = ["<b>Бэклог идей</b>", "Открой идею и нажми «В задачи», когда команда готова её делать.", ""];
    const kb: Btn[][] = [];
    for (const q of ["MVP", "v2", "Позже"]) {
      const neu = ideas.filter((i) => i.queue === q && i.status === "Новая").length;
      lines.push(`${q}: новых ${neu} из ${ideas.filter((i) => i.queue === q).length}`);
      kb.push([B(`${q} (${neu})`, `iq:${q}`)]);
    }
    return S(lines.join("\n"), [...kb, [B("Меню", "go:menu")]]);
  }

  async scrIdeaQueue(q: string): Promise<Screen> {
    const icon: Record<string, string> = { "Новая": "💡", "В задачах": "➡️", "Сделано": "✅", "Отклонена": "✖️" };
    const ideas = (await this.st.ideas()).filter((i) => i.queue === q)
      .sort((a, b) => Number(a.status !== "Новая") - Number(b.status !== "Новая") || a.group.localeCompare(b.group) || a.title.localeCompare(b.title));
    return S(`<b>Идеи · ${esc(q)}</b>`, [...ideas.slice(0, 50).map((i) => [B(`${icon[i.status] || "💡"} ${texts.cut(i.title, 42)}`, `i:v:${i.id}`)]), [B("← Идеи", "go:ideas")]]);
  }

  private async ideaCb(m: Member, p: string[]): Promise<Result> {
    const i = await this.st.idea(p[2]);
    if (!i) return R(undefined, { toast: "Идея не найдена", alert: true });
    if (p[1] === "v") {
      const kb: Btn[][] = [];
      if (i.status === "Новая") kb.push([B("➕ В задачи", `i:p:${i.id}`), B("✖️ Отклонить", `i:rej:${i.id}`)]);
      kb.push([U("Notion", notionUrl(i.id)), B("← К списку", `iq:${i.queue}`)]);
      return R(S(texts.ideaCard(i), kb));
    }
    if (p[1] === "p") return R(S(`«${esc(i.title)}» → в какой этап?`, [...STAGES.map((s, n) => [B(s, `i:ps:${i.id}:${n}`)]), [B("Отмена", `i:v:${i.id}`)]]));
    if (p[1] === "ps") {
      if (i.status !== "Новая") throw new ActionError("Идея уже обработана");
      const t = await this.svc.promoteIdea(i, m, STAGES[Number(p[3])] || "");
      return this.after(m, t, null, "Идея стала задачей");
    }
    if (p[1] === "rej") {
      await this.svc.rejectIdea(i);
      return R(await this.scrIdeaQueue(i.queue), { toast: "Идея отклонена" });
    }
    return R(undefined, { toast: "?" });
  }

  // --- team ----------------------------------------------------------------------------
  async scrTeam(m: Member): Promise<Screen> {
    const tasks = await this.st.tasks();
    const notion = new Map((await this.st.notionUsers()).map((u) => [u.id, u.name]));
    const lines = ["<b>Команда</b>", ""];
    const kb: Btn[][] = [];
    for (const x of await this.st.members()) {
      if (!x.approved) {
        if (m.admin) {
          lines.push(`⏳ ${esc(x.name)} — ждёт подтверждения`);
          kb.push([B(`✅ ${x.name}`, `m:ok:${x.tg_id}`), B("✖️", `m:no:${x.tg_id}`)]);
        }
        continue;
      }
      const active = tasks.filter((t) => t.assignee_tg === x.tg_id && !isDone(t));
      const od = logic.overdue(active, this.today()).length;
      const done = tasks.filter((t) => t.assignee_tg === x.tg_id && isDone(t)).length;
      const link = x.notion_user_id ? notion.get(x.notion_user_id) || "" : "";
      lines.push(`${x.admin ? "⭐ " : ""}<b>${esc(x.name)}</b>${x.username ? " @" + esc(x.username) : ""}\n`
        + `    в работе ${active.length}, готово ${done}${od ? `, просрочено ${od}` : ""}\n    Notion: ${link ? esc(link) : "не привязан"}`);
      if (m.admin || x.tg_id === m.tg_id) kb.push([B(`🔗 Notion для ${x.name}`, `m:link:${x.tg_id}`)]);
    }
    lines.push("", "Общий чат для сводок: " + ((await this.st.kvGet("group_chat")) ? "привязан" : "не привязан — /bindchat в чате"));
    return S(lines.join("\n"), [...kb, [B("Меню", "go:menu")]]);
  }

  private async memberCb(m: Member, p: string[]): Promise<Result> {
    const act = p[1];
    const uid = Number(p[2]);
    const x = await this.st.member(uid);
    if (!x) return R(undefined, { toast: "Участник не найден", alert: true });
    if (act === "ok" || act === "no") {
      if (!m.admin) throw new ActionError("Только администратор");
      if (act === "ok") {
        x.approved = true;
        await this.st.saveMember(x);
        return R(await this.scrTeam(m), { notices: [{ chatId: x.tg_id, text: "Тебя приняли в команду TheBearLab! /help — что я умею.", kb: [] }], toast: `${x.name} в команде` });
      }
      await this.st.delete("member", String(uid));
      return R(await this.scrTeam(m), { toast: "Заявка отклонена" });
    }
    if (act === "link" || act === "ln") {
      if (!(m.admin || uid === m.tg_id)) throw new ActionError("Можно привязать только себя");
      const users = (await this.st.notionUsers()).filter((u) => (u.type || "person") === "person");
      if (act === "link") {
        if (!users.length) return R(undefined, { toast: "Пользователи Notion ещё не загружены — дождись синхронизации", alert: true });
        return R(S(`Кто ${esc(x.name)} в Notion?`, [...users.map((u) => [B(u.name || u.id.slice(0, 8), `m:ln:${uid}:${u.id.replace(/-/g, "")}`)]), [B("← Команда", "go:team")]]));
      }
      const nid = users.find((u) => u.id.replace(/-/g, "") === p[3])?.id;
      if (!nid) throw new ActionError("Пользователь Notion не найден");
      x.notion_user_id = nid;
      await this.st.saveMember(x);
      for (const t of await this.st.tasks()) {
        if (t.assignee_tg === uid && t.assignee_notion !== nid) {
          t.assignee_notion = nid;
          t.dirty.includes("assignee_notion") || t.dirty.push("assignee_notion");
          t.rev += 1;
          await this.st.saveTask(t);
        } else if (t.assignee_notion === nid && !t.assignee_tg) {
          t.assignee_tg = uid;
          await this.st.saveTask(t);
        }
      }
      if (m.tg_id === uid) m.notion_user_id = nid;
      return R(await this.scrTeam(m), { toast: "Привязано" });
    }
    return R(undefined, { toast: "?" });
  }

  // --- sync ------------------------------------------------------------------------------
  async triggerSync(): Promise<Result> {
    if (!this.syncFn) return R(S("Синхронизация с Notion идёт автоматически каждые 10 минут."));
    const stamp = (await this.st.kvGet<number>("sync_requested")) || 0;
    if (Date.now() - stamp < 30000) return R(S("Синхронизация только что была — подожди полминуты."));
    await this.st.kvSet("sync_requested", Date.now());
    try {
      return R(S("Синхронизировано с Notion. " + esc(await this.syncFn())));
    } catch (e) {
      return R(S(`Не получилось синхронизироваться с Notion: ${esc(String(e).slice(0, 200))}`));
    }
  }
}
