// Telegram Bot API over fetch + update router into App.
//   • rich messages (Bot API 10.1+): screens with `rich` Markdown are sent with sendRichMessage, text is the fallback
//   • ephemeral replies (10.2+): button presses in groups are answered only to the person who pressed
//   • one window in private chats: the bot keeps one panel message and edits it; the user's messages are tidied away
//   • widgets (10.4): widget_query updates are routed to opts.widget
import type { App, Btn, Notice, Result, Screen, Who } from "./app.ts";
import type { FetchFn } from "./notion.ts";

// [command, description, ephemeral in groups]
export const COMMANDS: [string, string, boolean][] = [
  ["today", "Сводка: прогресс, просрочки, вехи", false],
  ["my", "Мой кабинет: мои задачи и напоминания", true],
  ["next", "Что делать дальше", true],
  ["free", "Свободные задачи", true],
  ["board", "Живая доска (в личке)", false],
  ["tasks", "Задачи по этапам", true],
  ["plan", "Роадмап", true],
  ["milestones", "Вехи", true],
  ["ideas", "Бэклог идей", true],
  ["new", "Новая задача", true],
  ["ask", "Вопрос ИИ-консультанту", false],
  ["find", "Поиск", true],
  ["team", "Команда", true],
  ["memory", "Память команды", true],
  ["settings", "Настройки уведомлений", true],
  ["window", "Одно окно в личке: вкл/выкл", true],
  ["sync", "Синхронизация с Notion", true],
  ["pin", "Закрепить живую сводку в чате", true],
  ["channel", "Канал с историей работы", true],
  ["help", "Что умеет бот", true],
];

export function keyboard(kb: Btn[][]): unknown {
  if (!kb || !kb.length) return undefined;
  return {
    inline_keyboard: kb.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: (b.data || "").slice(0, 64) }))),
  };
}

type TgResult = { ok: boolean; description?: string; result?: any };

/** Where and how a screen is delivered. */
export interface Target {
  chatId?: number;
  replyTo?: number;
  ephemeral?: { callback_query_id?: string; receiver_user_id?: number; replace_callback_query_message?: boolean };
  replyToEphemeral?: number;
}

export class TelegramApi {
  calls = 0;
  botUsername?: string;
  /** Called when the bot posts something new in a private chat, so «one window» opens a fresh panel below it. */
  onPrivatePost?: (chatId: number) => Promise<void>;
  private token: string;
  private fetchFn: FetchFn;

  constructor(token: string, fetchFn: FetchFn = (i, init) => fetch(i, init)) {
    this.token = token;
    this.fetchFn = fetchFn;
  }

  async call(method: string, payload: Record<string, unknown>): Promise<TgResult> {
    this.calls += 1;
    const r = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data: any = await r.json();
    if (!data.ok) console.warn(`telegram ${method} failed: ${data.description}`);
    return data;
  }

  async sendMessage(chatId: number, text: string, kb?: Btn[][], replyTo?: number) {
    if (chatId > 0 && this.onPrivatePost) await this.onPrivatePost(chatId);
    return this.call("sendMessage", {
      chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard(kb || []),
      reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
    });
  }

  /** Send a screen: rich message when it has `rich` Markdown, plain HTML text otherwise or as a fallback. */
  async sendScreen(s: Screen, t: Target, prefix = { html: "", md: "" }): Promise<TgResult> {
    const common: Record<string, unknown> = {
      chat_id: t.chatId, reply_markup: keyboard(s.kb),
      ephemeral_message_parameters: t.ephemeral,
      reply_parameters: t.replyToEphemeral ? { ephemeral_message_id: t.replyToEphemeral }
        : t.replyTo ? { message_id: t.replyTo, allow_sending_without_reply: true } : undefined,
    };
    if (s.rich) {
      const r = await this.call("sendRichMessage", { ...common, rich_message: { markdown: prefix.md + s.rich } });
      if (r.ok) return r;
    }
    return this.call("sendMessage", { ...common, text: prefix.html + s.text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }

  async editScreen(s: Screen, chatId: number, messageId: number, prefix = { html: "", md: "" }): Promise<TgResult> {
    if (s.rich) {
      const r = await this.call("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: { markdown: prefix.md + s.rich }, reply_markup: keyboard(s.kb) });
      if (r.ok || (r.description || "").includes("not modified")) return { ...r, ok: true };
    }
    const r = await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: prefix.html + s.text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard(s.kb) });
    return (r.description || "").includes("not modified") ? { ...r, ok: true } : r;
  }

  async editEphemeral(s: Screen, chatId: number, receiver: number, ephemeralId: number): Promise<TgResult> {
    const base = { chat_id: chatId, receiver_user_id: receiver, ephemeral_message_id: ephemeralId, reply_markup: keyboard(s.kb) };
    if (s.rich) {
      const r = await this.call("editEphemeralMessageText", { ...base, rich_message: { markdown: s.rich } });
      if (r.ok) return r;
    }
    return this.call("editEphemeralMessageText", { ...base, text: s.text, parse_mode: "HTML" });
  }

  pin(chatId: number, messageId: number) {
    return this.call("pinChatMessage", { chat_id: chatId, message_id: messageId, disable_notification: true });
  }

  deleteMessage(chatId: number, messageId: number) {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  /** The bot's @username (without @), asked from Telegram once and cached on the object. */
  async username(): Promise<string> {
    if (!this.botUsername) {
      const me = await this.call("getMe", {});
      this.botUsername = me.ok ? me.result.username : "";
    }
    return this.botUsername || "";
  }

  editMessage(chatId: number, messageId: number, text: string, kb?: Btn[][]) {
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard(kb || []) });
  }

  answerCallback(id: string, text?: string, alert = false) {
    return this.call("answerCallbackQuery", { callback_query_id: id, text: text ? text.slice(0, 190) : undefined, show_alert: alert });
  }

  setWebhook(url: string, secret?: string) {
    return this.call("setWebhook", { url, secret_token: secret || undefined, allowed_updates: ["message", "callback_query", "widget_query"] });
  }

  typing(chatId: number) {
    return this.call("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  /** Download a file sent to the bot (voice message). */
  async download(fileId: string): Promise<ArrayBuffer> {
    const f = await this.call("getFile", { file_id: fileId });
    if (!f.ok) throw new Error(f.description || "getFile failed");
    this.calls += 1;
    const r = await this.fetchFn(`https://api.telegram.org/file/bot${this.token}/${f.result.file_path}`);
    return r.arrayBuffer();
  }

  setCommands() {
    return this.call("setMyCommands", { commands: COMMANDS.map(([command, description, eph]) => ({ command, description, is_ephemeral: eph || undefined })) });
  }
}

export async function sendNotices(tg: TelegramApi, notices: Notice[]): Promise<void> {
  for (const n of notices) {
    try {
      if (n.chatId > 0 && tg.onPrivatePost) await tg.onPrivatePost(n.chatId);
      if (n.photo) {
        const p = await tg.call("sendPhoto", { chat_id: n.chatId, photo: n.photo, caption: n.text.slice(0, 1000), parse_mode: "HTML", reply_markup: keyboard(n.kb) });
        if (p.ok) continue;
        console.warn("photo failed", p.description);
      }
      const r = n.rich ? await tg.sendScreen({ text: n.text, kb: n.kb, rich: n.rich }, { chatId: n.chatId }) : await tg.sendMessage(n.chatId, n.text, n.kb);
      if (!r.ok) console.warn("notice failed", n.chatId, r.description);   // user never opened the bot, blocked it…
    } catch (e) {
      console.warn("notice failed", n.chatId, String(e));
    }
  }
}

const who = (u: any): Who => ({ id: u.id, name: u.first_name || u.username || String(u.id), username: u.username || "" });
const escHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escMd = (s: string): string => s.replace(/([\\`*_~|[\]()#>=])/g, "\\$1");

/** Words that address the bot in a group when a message starts with them («Бро, что горит?»). */
export const NICKNAMES = ["бро", "bro", "бот", "брат", "братан"];

/** If the message starts or ends with a nickname («Бро, что горит?», «так и че, бро?»), returns the rest; otherwise null. */
export function stripNickname(text: string, nicknames: string[] = NICKNAMES): string | null {
  const t = text.trim();
  const head = t.match(/^([\p{L}]+)[\s,.:!?…—-]*(.*)$/su);
  if (head && nicknames.includes(head[1].toLowerCase())) return head[2].trim();
  const tail = t.match(/^(.*?)[\s,.:—-]+([\p{L}]+)\s*([?!.…]*)$/su);
  if (tail && nicknames.includes(tail[2].toLowerCase())) return (tail[1].trim() + (tail[3].includes("?") ? "?" : "")).trim();
  return null;
}

/** Remembers the bot's panel message per private chat («one window»). */
export interface PanelStore {
  enabled(userId: number): Promise<boolean>;
  get(chatId: number): Promise<number | null>;
  set(chatId: number, messageId: number): Promise<void>;
}

export interface UpdateOptions {
  /** Called for ordinary group messages (not addressed to the bot) — the source for remembered conclusions. */
  bufferGroup?: (chatId: number, who: string, text: string) => Promise<void>;
  /** Speech-to-text for voice messages; absent → voice is not supported. */
  transcribe?: (audio: ArrayBuffer) => Promise<string>;
  panel?: PanelStore;
  /** Handles a widget_query update (the live board). */
  widget?: (q: any) => Promise<void>;
  /** Sends the live board widget; returns false when it could not. */
  board?: (chatId: number, from: Who, isPrivate: boolean) => Promise<void>;
}

const isGroup = (chat: any): boolean => chat && (chat.type === "group" || chat.type === "supergroup");

/** Route one Telegram update into the App and deliver the result. */
export async function handleUpdate(update: any, app: App, tg: TelegramApi, opts: UpdateOptions = {}): Promise<void> {
  if (update.widget_query) {
    if (opts.widget) await opts.widget(update.widget_query);
    else await tg.call("answerWidgetQuery", { widget_query_id: update.widget_query.id });
    return;
  }

  if (update.callback_query) {
    const cb = update.callback_query;
    const msg = cb.message;
    const chatId: number = msg ? msg.chat.id : cb.from.id;
    if (cb.data === "go:board" && opts.board) {
      await tg.answerCallback(cb.id, "Открываю доску");
      await opts.board(chatId, who(cb.from), msg?.chat?.type === "private");
      return;
    }
    const res = await app.onCallback(who(cb.from), chatId, cb.data || "");
    await tg.answerCallback(cb.id, res.toast, !!res.alert);
    if (res.publicEdit && msg && !msg.ephemeral_message_id) await tg.editScreen(res.publicEdit, chatId, msg.message_id);
    if (res.screen && msg) {
      if (msg.ephemeral_message_id) {
        // the button sits in an ephemeral message: edit it for this person
        const r = await tg.editEphemeral(res.screen, chatId, cb.from.id, msg.ephemeral_message_id);
        if (!r.ok) await tg.sendScreen(res.screen, { chatId, ephemeral: { receiver_user_id: cb.from.id } });
      } else if (isGroup(msg.chat)) {
        // a shared message in a group: answer only to the person who pressed, in place of the message
        const r = await tg.sendScreen(res.screen, { ephemeral: { callback_query_id: cb.id, replace_callback_query_message: !res.newMessage } });
        if (!r.ok) await tg.sendScreen(res.screen, { chatId });
      } else if (res.newMessage && !(opts.panel && await opts.panel.enabled(cb.from.id))) {
        await tg.sendScreen(res.screen, { chatId });
      } else {
        const r = await tg.editScreen(res.screen, chatId, msg.message_id);
        if (!r.ok) {
          const s = await tg.sendScreen(res.screen, { chatId });
          if (s.ok && opts.panel) await opts.panel.set(chatId, s.result.message_id);
        } else if (opts.panel && !isGroup(msg.chat)) await opts.panel.set(chatId, msg.message_id);
      }
    }
    await sendNotices(tg, res.notices);
    return;
  }

  const msg = update.message;
  console.log("update", JSON.stringify({ id: update.update_id, chat: msg?.chat?.type, text: msg?.chat?.type === "private" && typeof msg?.text === "string" ? msg.text.slice(0, 60) : undefined, voice: !!msg?.voice, eph: !!msg?.ephemeral_message_id, keys: Object.keys(msg || update) }));
  if (!msg || !msg.from) return;
  const chatId: number = msg.chat.id;
  const isPrivate = msg.chat.type === "private";
  // a post forwarded from a channel right after /channel = «connect this channel» (works for private channels)
  if (isPrivate && msg.forward_origin?.type === "channel" && msg.forward_origin.chat?.id && await app.wantsChannel(msg.from.id)) {
    msg.text = `/channel ${msg.forward_origin.chat.id}`;
  }
  let text: string | undefined = typeof msg.text === "string" ? msg.text : undefined;
  let heard = "";

  const voice = msg.voice || msg.audio;
  let voiceInGroup = false;
  if (!text && voice) {
    if (isPrivate && !(await app.memberOf(who(msg.from)))) {
      await tg.sendMessage(chatId, "Отправь /start, чтобы попасть в команду.");
      return;
    }
    if (!opts.transcribe) {
      if (isPrivate) await tg.sendMessage(chatId, "Голосовые пока не подключены — напиши текстом.");
      return;
    }
    // In a group every voice note is transcribed, but the bot answers only if it starts/ends with «бро».
    // Nothing is stored: the text lives only while this message is processed.
    if (isPrivate) await tg.typing(chatId);
    try {
      text = await opts.transcribe(await tg.download(voice.file_id));
    } catch (e) {
      console.error("transcribe failed", e);
      if (isPrivate) await tg.sendMessage(chatId, "Не получилось распознать голосовое — попробуй ещё раз или напиши текстом.");
      return;
    }
    if (!text) {
      if (isPrivate) await tg.sendMessage(chatId, "Не расслышал — попробуй ещё раз.");
      return;
    }
    voiceInGroup = !isPrivate;
    heard = text;
    console.log("voice", isPrivate ? "private" : "group", `${text.length} chars`);
  }
  if (typeof text !== "string") return;

  let res: Result | null;
  let replyTo: number | undefined;
  let isCommand = false;
  if (text.startsWith("/")) {
    isCommand = true;
    const [head] = text.split(/\s+/);
    const cmd = head.slice(1).split("@")[0].toLowerCase();
    const mention = head.includes("@") ? head.split("@")[1] : "";
    if (mention && tg.botUsername && mention.toLowerCase() !== tg.botUsername.toLowerCase()) return;   // command for another bot
    if (cmd === "start" && !isPrivate) {
      await tg.sendMessage(chatId, "Напиши мне в личку /start, чтобы попасть в команду.");
      return;
    }
    if (cmd === "board" && opts.board) {
      await opts.board(chatId, who(msg.from), isPrivate);
      return;
    }
    if (cmd === "ask" && app.askFn) await tg.typing(chatId);
    res = await app.onCommand(who(msg.from), chatId, isPrivate, cmd, text.slice(head.length).trim());
  } else if (!isPrivate) {
    // In a group the bot answers only when addressed: @mention, a reply to its message or «Бро, …».
    const me = (await tg.username()).toLowerCase();
    const mentioned = !!me && text.toLowerCase().includes("@" + me);
    const r = msg.reply_to_message?.from;
    const replyToBot = !!r?.is_bot && (!me || (r.username || "").toLowerCase() === me);
    const byNick = stripNickname(text);
    if (!mentioned && !replyToBot && byNick === null) {
      if (!voiceInGroup && opts.bufferGroup) await opts.bufferGroup(chatId, who(msg.from).name, text);
      return;
    }
    if (voiceInGroup && byNick === null && !replyToBot) return;
    let q = me ? text.replace(new RegExp("@" + me, "ig"), " ").replace(/\s+/g, " ").trim() : text;
    if (byNick !== null && !mentioned) q = byNick;
    if (app.askFn) await tg.typing(chatId);
    res = await app.onGroupText(who(msg.from), chatId, q);
    replyTo = msg.message_id;
  } else {
    if (app.askFn && !heard) await tg.typing(chatId);
    res = await app.onText(who(msg.from), chatId, isPrivate, text);
  }
  console.log("result", JSON.stringify({ screen: res ? res.screen?.text.slice(0, 80) : null, notices: res?.notices.length }));
  if (!res) return;

  if (res.screen) {
    // what the person asked — shown at the top of the answer (voice: what the bot heard; one window: the question)
    const asked = heard || (isPrivate && !isCommand ? text : "");
    const prefix = asked ? { html: `${heard ? "🎙" : "❓"} <i>${escHtml(asked.slice(0, 300))}</i>\n\n`, md: `${heard ? "🎙" : "❓"} _${escMd(asked.slice(0, 300))}_\n\n` } : { html: "", md: "" };
    if (msg.ephemeral_message_id) {
      // an ephemeral command in a group: answer only to its author
      await tg.sendScreen(res.screen, { chatId, replyToEphemeral: msg.ephemeral_message_id, ephemeral: { receiver_user_id: msg.from.id } }, prefix);
    } else if (isPrivate && opts.panel && await opts.panel.enabled(msg.from.id) && !(isCommand && text.startsWith("/start"))) {
      // one window: edit the panel, tidy away the person's message
      const panelId = await opts.panel.get(chatId);
      const edited = panelId ? await tg.editScreen(res.screen, chatId, panelId, prefix) : { ok: false };
      if (!edited.ok) {
        const s = await tg.sendScreen(res.screen, { chatId }, prefix);
        if (s.ok) await opts.panel.set(chatId, s.result.message_id);
      }
      await tg.deleteMessage(chatId, msg.message_id);
    } else {
      const s = await tg.sendScreen(res.screen, { chatId, replyTo }, heard ? prefix : { html: "", md: "" });
      if (s.ok && isPrivate && opts.panel) await opts.panel.set(chatId, s.result.message_id);
    }
  }
  await sendNotices(tg, res.notices);
}
