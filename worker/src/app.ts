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
import { forget, memories } from "./memory.ts";
import * as rich from "./rich.ts";
import { GROUP_LABELS, PREF_LABELS, getGroupPrefs, getPrefs, toggleGroupPref, togglePref } from "./prefs.ts";
import type { GroupPrefs, Prefs } from "./prefs.ts";
import { planNotice } from "./plan.ts";
import type { WeekPlan } from "./plan.ts";

export interface Btn { text: string; data?: string; url?: string }
export interface Screen { text: string; kb: Btn[][]; rich?: string }   // rich: Markdown for a Telegram rich message
export interface Notice { chatId: number; text: string; kb: Btn[][]; rich?: string; photo?: string }
export interface Result { screen?: Screen; notices: Notice[]; toast?: string; alert?: boolean; newMessage?: boolean; publicEdit?: Screen }
export interface Who { id: number; name: string; username?: string }

const B = (text: string, data: string): Btn => ({ text, data });
const U = (text: string, url: string): Btn => ({ text, url });
const S = (text: string, kb: Btn[][] = []): Screen => ({ text, kb });
const R = (screen?: Screen, extra: Partial<Result> = {}): Result => ({ screen, notices: [], ...extra });

const STATUS_BTN: Record<string, string> = { "Не начато": "⚪ Не начато", "В работе": "🔵 В работу", "На проверке": "🟡 На проверку", "Готово": "✅ Готово" };
const BROADCAST_ICON: Record<string, string> = { take: "🙋", release: "↩️", assign: "👥", done: "✅", status: "🔄", due: "📅", create: "➕", result: "🔗" };

export const MENU: Btn[][] = [
  [B("Сводка", "go:today"), B("Мой кабинет", "go:my"), B("Что дальше", "go:next")],
  [B("Свободные", "go:free"), B("Этапы", "go:tasks"), B("Роадмап", "go:plan")],
  [B("Идеи", "go:ideas"), B("Новая задача", "go:new"), B("Команда", "go:team")],
  [B("📊 Живая доска", "go:board"), B("🧠 Память", "go:memory"), B("⚙️", "go:settings")],
];

export interface AskOpts { group?: boolean; chatId?: number; checkin?: boolean }
export type AskFn = (m: Member, text: string, opts?: AskOpts) => Promise<Result>;
export interface AppOptions { adminIds?: Set<string>; syncFn?: () => Promise<string>; askFn?: AskFn }

export class App {
  st: Storage;
  clock: Clock;
  svc: Service;
  adminIds: Set<string>;
  syncFn?: () => Promise<string>;
  askFn?: AskFn;      // AI consultant; when absent, free text is a search
  pageTextFn?: (t: Task) => Promise<string>;   // text inside the task's Notion page
  chat = 0;           // chat of the current update (private chat id = user id)

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
    this.chat = chatId;
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
        if ((await getGroupPrefs(this.st)).pinned) await this.st.kvSet("pin_wanted", true);
        return R(S("Готово! Сюда будут приходить: сводка в 09:00, вечерняя сверка в 18:00, план недели в понедельник, итоги в пятницу и все взятия/снятия/закрытия задач. Ещё закреплю живую сводку — для этого дай мне права администратора с правом закреплять сообщения."));
      case "pin":
        if (isPrivate) return R(S("Отправь /pin в общем чате — там закреплю живую сводку."));
        if (Number(await this.st.kvGet("group_chat")) !== chatId) return R(S("Сначала привяжи этот чат: /bindchat."));
        await this.st.kvSet("pin_wanted", true);
        return R(S("Сейчас закреплю живую сводку. Если не получится — дай мне права администратора с правом закреплять сообщения."));
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
        return this.askFn(m, args, { chatId, group: !isPrivate });
      case "cancel":
        return R(S("Ок, отменил.", MENU));
      case "memory":
        return R(await this.scrMemory(0));
      case "settings":
        return R(await this.scrSettings(m));
      case "cabinet":
        return R(await this.scrMy(m));
      case "window": {
        const on = (await togglePref(this.st, m.tg_id, "window")).window;
        return R(S(on
          ? "Включил «одно окно»: в личке я обновляю одно сообщение, а твои вопросы убираю, чтобы чат был чистым. Выключить: /window"
          : "Выключил «одно окно»: каждый ответ — новым сообщением, твои сообщения остаются. Включить: /window", MENU));
      }
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
    this.chat = chatId;
    if (!isPrivate) return null;
    const m = await this.member(who);
    if (!m) return R(S("Отправь /start, чтобы попасть в команду."));
    text = (text || "").trim();
    const aw = await this.st.kvGet<Record<string, string>>(`await:${m.tg_id}`);
    if (aw) return this.onAwait(m, aw, text);
    if (this.askFn) return this.askFn(m, text, { chatId });
    return R(await this.scrSearch(text));
  }

  /** A group message addressed to the bot (@mention or reply). */
  async onGroupText(who: Who, chatId: number, text: string): Promise<Result | null> {
    this.svc.recent = [];
    this.chat = chatId;
    const m = await this.member(who);
    if (!m) return R(S("Чтобы я отвечал тебе, напиши мне в личку /start — администратор примет заявку."));
    if (!text) return R(S("Я здесь. Спроси что-нибудь, например: «что горит на этой неделе?» — или открой меню.", MENU));
    if (this.askFn) return this.askFn(m, text, { group: true, chatId });
    return R(await this.scrSearch(text));
  }

  async onCallback(who: Who, chatId: number, data: string): Promise<Result> {
    this.svc.recent = [];
    this.chat = chatId;
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
        case "pl": return await this.planCb(m, p);
        case "ci":
          await this.st.kvDel(`await:${m.tg_id}`);
          return R(S("Ок, бывает. Завтра будет лучше 💪", MENU));
        case "pf": {
          const k = p[1] as keyof Prefs;
          if (!PREF_LABELS.some(([x]) => x === k)) break;
          await togglePref(this.st, m.tg_id, k);
          return R(await this.scrSettings(m), { toast: "Сохранено" });
        }
        case "gp": {
          const k = p[1] as keyof GroupPrefs;
          if (!m.admin) throw new ActionError("Только администратор");
          if (!GROUP_LABELS.some(([x]) => x === k)) break;
          await toggleGroupPref(this.st, k);
          return R(await this.scrSettings(m), { toast: "Сохранено" });
        }
        case "mem": {
          if (p[1] === "del") {
            await forget(this.st, p[2]);
            return R(await this.scrMemory(Number(p[3] || 0)), { toast: "Удалено — и из Notion тоже" });
          }
          return R(await this.scrMemory(Number(p[2] || 0)));
        }
        case "ai": {
          const topics = (await this.st.kvGet<string[]>(`topics:${m.tg_id}`)) || [];
          const topic = topics[Number(p[1])];
          if (!topic || !this.askFn) return R(undefined, { toast: "Тема устарела — задай вопрос заново" });
          const r = await this.askFn(m, topic, { chatId, group: chatId !== m.tg_id });
          r.newMessage = true;
          r.toast = topic;
          return r;
        }
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
      board: async () => S("Живая доска открывается в личке: отправь /board.", MENU),
      settings: () => this.scrSettings(m),
      memory: () => this.scrMemory(0),
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
    return { ...S(await texts.teamDigest(this.st, this.today()), [[B("Мои задачи", "go:my"), B("Что дальше", "go:next")], [B("Меню", "go:menu")]]),
      rich: await rich.digest(this.st, this.today()) };
  }

  private async taskButtons(tasks: Task[]): Promise<Btn[][]> {
    const today = this.today();
    const names = await texts.Names.load(this.st);
    return tasks.map((t) => [B(texts.buttonLabel(t, today, names), `t:v:${t.id}`)]);
  }

  /** Personal task cabinet: my tasks grouped by urgency, my reminders. */
  async scrMy(m: Member): Promise<Screen> {
    const today = this.today();
    const mine = (await this.st.tasks()).filter((t) => t.assignee_tg === m.tg_id && !isDone(t));
    const reminders = (await this.st.all<{ id: string; tg: number; at: string; text: string; by: string }>("reminder")).filter((r) => r.tg === m.tg_id).sort((a, b) => a.at.localeCompare(b.at));
    if (!mine.length && !reminders.length) {
      return S("<b>Мой кабинет</b>\n\nНа тебе нет открытых задач. Посмотри /free или /next.", [[B("Свободные", "go:free"), B("Что дальше", "go:next")], [B("⚙️ Настройки", "go:settings")]]);
    }
    const groups: [string, Task[]][] = [
      ["⏰ Просрочено", logic.overdue(mine, today)],
      ["📅 Сегодня", mine.filter((t) => t.due === today && t.status !== "На проверке")],
      ["🗓 На неделе", mine.filter((t) => t.due && t.due > today && t.due <= addDays(today, 7) && t.status !== "На проверке")],
      ["🟡 На проверке", mine.filter((t) => t.status === "На проверке")],
      ["📂 Позже и без срока", mine.filter((t) => t.status !== "На проверке" && (!t.due || t.due > addDays(today, 7)))],
    ];
    const lines = [`<b>Мой кабинет · ${esc(m.name)}</b>`, `Открытых задач: ${mine.length}`];
    const mdl = [`### Мой кабинет · ${rich.md(m.name)}`, `Открытых задач: **${mine.length}**`];
    const kb: Btn[][] = [];
    const names = await texts.Names.load(this.st);
    for (const [title, ts] of groups) {
      if (!ts.length) continue;
      lines.push("", `<b>${title} (${ts.length})</b>`, ...ts.map((t) => `${names.marker(t, today)} ${esc(t.title)}${t.due ? " · " + texts.shortDate(t.due) : ""}`));
      mdl.push(`#### ${title} (${ts.length})`, ts.map((t) => `- ${names.marker(t, today)} ${rich.md(t.title)}${t.due ? ` · ${texts.shortDate(t.due)}` : ""}`).join("\n"));
      for (const t of ts) if (kb.length < 30) kb.push([B(texts.buttonLabel(t, today, names), `t:v:${t.id}`)]);
    }
    if (reminders.length) {
      const rl = reminders.slice(0, 8).map((r) => `${r.at.slice(8, 10)}.${r.at.slice(5, 7)} ${r.at.slice(11, 16)} — ${r.text}`);
      lines.push("", "<b>⏰ Мои напоминания</b>", ...rl.map((x) => "• " + esc(x)));
      mdl.push("#### ⏰ Мои напоминания", rl.map((x) => "- " + rich.md(x)).join("\n"));
    }
    kb.push([B("Что дальше", "go:next"), B("⚙️ Настройки", "go:settings")], [B("Меню", "go:menu")]);
    return { text: lines.join("\n"), kb, rich: mdl.join("\n\n") };
  }

  // --- settings --------------------------------------------------------------------
  async scrSettings(m: Member): Promise<Screen> {
    const p = await getPrefs(this.st, m.tg_id);
    const kb: Btn[][] = PREF_LABELS.map(([k, label]) => [B(`${p[k] ? "✅" : "⬜"} ${label}`, `pf:${k}`)]);
    const lines = ["<b>Настройки уведомлений</b>", "Нажми, чтобы включить или выключить. Действует только для тебя."];
    if (m.admin) {
      const g = await getGroupPrefs(this.st);
      lines.push("", "<b>Общий чат</b> (для всей команды, меняет администратор)");
      kb.push(...GROUP_LABELS.map(([k, label]) => [B(`${g[k] ? "✅" : "⬜"} ${label}`, `gp:${k}`)]));
    }
    kb.push([B("Мой кабинет", "go:my"), B("Меню", "go:menu")]);
    return S(lines.join("\n"), kb);
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
    return S(text, [...await this.taskButtons(sug.map((s) => s.task)), [B("Меню", "go:menu")]]);
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
    const kb = await this.taskButtons((showAll ? ts : ts.filter((t) => !isDone(t))).slice(0, 50));
    if (!showAll && d) kb.push([B(`Показать выполненные (${d})`, `s:${idx}:all`)]);
    kb.push([B("← Этапы", "go:tasks"), B("Меню", "go:menu")]);
    return S(`<b>${esc(name)}</b>\n${logic.bar(p)} ${d}/${n}`, kb);
  }

  async scrPlan(): Promise<Screen> {
    return { ...S(await texts.plan(this.st, this.today()), [[B("Вехи", "go:ms"), B("Этапы", "go:tasks")], [B("Меню", "go:menu")]]),
      rich: await rich.plan(this.st, this.today()) };
  }

  async scrMilestones(): Promise<Screen> {
    const tasks = await this.st.tasks();
    const ms = await this.st.milestones();
    const lines = ["<b>Вехи</b>", "", ...ms.map((x) => texts.milestoneLine(x, tasks, this.today()))];
    return { ...S(lines.join("\n"), [...ms.map((x) => [B(texts.cut(x.title, 45), `ms:v:${x.id}`)]), [B("Меню", "go:menu")]]),
      rich: await rich.milestones(this.st, this.today()) };
  }

  async scrMilestone(mid: string): Promise<Screen> {
    const x = (await this.st.milestones()).find((m) => m.id === mid);
    if (!x) return S("Веха не найдена.", MENU);
    const tasks = await this.st.tasks();
    const linked = logic.milestoneTasks(x, tasks).sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || (a.due || "9999").localeCompare(b.due || "9999"));
    let text = texts.milestoneLine(x, tasks, this.today());
    if (x.criterion) text += `\n\n<b>Критерий:</b> ${esc(x.criterion)}`;
    return S(text, [...await this.taskButtons(linked.slice(0, 40)), [U("Открыть в Notion", notionUrl(x.id))], [B("← Вехи", "go:ms")]]);
  }

  async scrSearch(query: string): Promise<Screen> {
    const hits = logic.search(query, await this.st.tasks(), await this.st.ideas());
    if (!hits.length) return S(`По запросу «${esc(query)}» ничего не нашёл.`, MENU);
    const today = this.today();
    const names = await texts.Names.load(this.st);
    const kb = hits.map((h) => h.kind === "task"
      ? [B(texts.buttonLabel(h.obj, today, names), `t:v:${h.obj.id}`)]
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
    let body = "";
    if (this.pageTextFn) { try { body = (await this.pageTextFn(t)).trim(); } catch (e) { console.warn("page text failed", e); } }
    const room = Math.min(1200, 3900 - text.length - 120);
    const html = body && room > 200 ? `${text}\n\n<b>📄 Из страницы Notion</b>\n<blockquote expandable>${esc(body.slice(0, room))}${body.length > room ? "…" : ""}</blockquote>` : text;
    let r = await rich.taskCard(t, this.st, this.today(), evs);
    if (body) r += `\n\n<details><summary>📄 Из страницы Notion</summary>\n\n${body.slice(0, 2500).split("\n").filter((x) => x.trim()).map(rich.md).join("\n\n")}${body.length > 2500 ? "…" : ""}\n\n</details>`;
    return { ...S(html, kb), rich: r };
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
          if (uid === t.assignee_tg && uid !== prevOwner) notices.push(await this.cabinetCard(t, uid, `${m.name} назначил(а) тебе задачу`));
          else notices.push({ chatId: uid, text: `<b>${esc(m.name)}</b> → «${esc(t.title)}»: ${esc(summary)}`, kb: [[B("Открыть", `t:v:${t.id}`)]] });
        }
      }
      // took it yourself in a group or by voice → the card still lands in your private chat
      if (t.assignee_tg === m.tg_id && prevOwner !== m.tg_id && this.chat !== m.tg_id && (await getPrefs(this.st, m.tg_id)).cabinet) {
        notices.push(await this.cabinetCard(t, m.tg_id, "Ты взял(а) задачу"));
      }
    }
    return notices;
  }

  /** A card sent to the private chat when a task lands in someone's cabinet. */
  async cabinetCard(t: Task, tgId: number, why: string): Promise<Notice> {
    const today = this.today();
    let when = "без срока — договоритесь о дате";
    if (t.due) {
      const d = logic.parseDate(t.due, today) ? Math.round((Date.parse(t.due) - Date.parse(today)) / 86400000) : 0;
      when = `${texts.shortDate(t.due)}${d < 0 ? ` — уже просрочена на ${logic.daysStr(-d)}` : d === 0 ? " — сегодня" : ` — через ${logic.daysStr(d)}`}`;
    }
    return {
      chatId: tgId,
      text: `📌 <b>В твоём кабинете новая задача</b>\n${esc(why)}: «${esc(t.title)}»\nСрок: ${when}\n\nНапомню утром в день срока и вечером накануне.`,
      kb: [[B("Открыть задачу", `t:v:${t.id}`), B("Мой кабинет", "go:my")]],
    };
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
    if (a === "checkin") return this.checkinAnswer(m, aw, text);
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

  /** Monday plan buttons: accept one item, skip one, or accept everything left. */
  private async planCb(m: Member, p: string[]): Promise<Result> {
    const plan = await this.st.kvGet<WeekPlan>("week_plan");
    if (!plan) return R(undefined, { toast: "План устарел", alert: true });
    const idx = p[1] === "all" ? plan.items.map((_, i) => i).filter((i) => !plan.items[i].state) : [Number(p[2])];
    const members = await this.st.members();
    const notices: Notice[] = [];
    let applied = 0;
    for (const i of idx) {
      const it = plan.items[i];
      if (!it || it.state) continue;
      if (p[1] === "no") { it.state = "no"; continue; }
      const t = await this.st.task(it.t);
      const target = members.find((x) => x.tg_id === it.who && x.approved);
      it.state = "ok";
      if (!t || isDone(t) || !target) continue;
      const prev = t.assignee_tg;
      this.svc.recent = [];
      let cur = t;
      if (cur.assignee_tg !== target.tg_id) cur = await this.svc.assign(cur, m, target);
      if (it.due && cur.due !== it.due) cur = await this.svc.setDue(cur, m, it.due);
      notices.push(...(await this.noticesFor(m, cur, prev)).filter((n) => n.chatId !== Number(this.chat)));
      applied++;
    }
    this.svc.recent = [];
    await this.st.kvSet("week_plan", plan);
    const tasks = new Map((await this.st.tasks()).map((t) => [t.id, t]));
    const names = new Map(members.map((x) => [x.tg_id, x.name]));
    const n = planNotice(plan, tasks, names, this.chat);
    return R(undefined, { notices, toast: p[1] === "no" ? "Пропущено" : `Принято: ${applied}`, publicEdit: { text: n.text, kb: n.kb } });
  }

  /** Answer to the evening check-in: goes into the journals of my tasks. */
  private async checkinAnswer(m: Member, aw: Record<string, string>, text: string): Promise<Result> {
    await this.st.kvDel(`await:${m.tg_id}`);
    if (aw.d !== this.today()) return this.askFn ? this.askFn(m, text, { chatId: m.tg_id }) : R(await this.scrSearch(text));
    if (/^(ничего|нет|-|пусто)\.?$/i.test(text)) return R(S("Ок, бывает. Завтра будет лучше 💪", MENU));
    if (this.askFn) return this.askFn(m, `Мой ответ на чек-ин: ${text}`, { chatId: m.tg_id, checkin: true });
    // Without AI: tasks named in the answer, else the only task in work.
    const mine = (await this.st.tasks()).filter((t) => t.assignee_tg === m.tg_id && !isDone(t));
    let hit = logic.search(text, mine, [], 3).map((h) => h.obj as Task).filter((t) => mine.includes(t));
    if (!hit.length) { const w = mine.filter((t) => t.status === "В работе"); if (w.length === 1) hit = w; }
    if (!hit.length) {
      const names = await texts.Names.load(this.st);
      return R(S("Не понял, к какой задаче это относится. Открой задачу и нажми «📝 Заметка».", mine.slice(0, 10).map((t) => [B(texts.buttonLabel(t, this.today(), names), `t:note:${t.id}`)])));
    }
    for (const t of hit) await this.svc.note(t, m, `Чек-ин: ${text.slice(0, 500)}`);
    return R(S(`Записал в журнал: ${hit.map((t) => "«" + esc(t.title) + "»").join(", ")}.`, MENU));
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

  // --- memory ------------------------------------------------------------------------
  async scrMemory(page = 0): Promise<Screen> {
    const all = (await memories(this.st)).reverse();
    const per = 8;
    const items = all.slice(page * per, page * per + per);
    const icon: Record<string, string> = { "Решение": "✅", "Вывод": "💡", "Договорённость": "🤝", "Факт": "📌" };
    const lines = ["<b>Память команды</b>", "Решения, выводы и договорённости из переписки. Они же — в Notion, база «Память команды».", ""];
    if (!all.length) lines.push("Пока пусто. Скажи боту «запомни, что…» или просто обсуждайте — выводы он сохранит сам.");
    items.forEach((x, i) => lines.push(`${page * per + i + 1}. ${icon[x.kind] || "📌"} ${esc(x.text)} <i>— ${esc(x.by || x.source)}, ${x.ts.slice(8, 10)}.${x.ts.slice(5, 7)}</i>`));
    const kb: Btn[][] = items.map((x, i) => [B(`🗑 Удалить ${page * per + i + 1}`, `mem:del:${x.id}:${page}`)]);
    const nav: Btn[] = [];
    if (page > 0) nav.push(B("← Новее", `mem:p:${page - 1}`));
    if ((page + 1) * per < all.length) nav.push(B("Старее →", `mem:p:${page + 1}`));
    if (nav.length) kb.push(nav);
    kb.push([B("Меню", "go:menu")]);
    return S(lines.join("\n"), kb);
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
    const names = await texts.Names.load(this.st);
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
      lines.push(`${names.colorOf(x.tg_id)} ${x.admin ? "⭐ " : ""}<b>${esc(x.name)}</b>${x.username ? " @" + esc(x.username) : ""}\n`
        + `    в работе ${active.length}, готово ${done}${od ? `, просрочено ${od}` : ""}\n    Notion: ${link ? esc(link) : "не привязан"}`);
      if (m.admin || x.tg_id === m.tg_id) kb.push([B(`🔗 Notion для ${x.name}`, `m:link:${x.tg_id}`)]);
    }
    lines.push("", "<b>Маркеры задач:</b> " + esc(names.legend()));
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
