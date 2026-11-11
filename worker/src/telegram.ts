// Telegram Bot API over fetch + update router into App.
import type { App, Btn, Notice, Result, Who } from "./app.ts";
import type { FetchFn } from "./notion.ts";

export const COMMANDS: [string, string][] = [
  ["today", "Сводка: прогресс, просрочки, вехи"],
  ["my", "Мои задачи"],
  ["next", "Что делать дальше"],
  ["free", "Свободные задачи"],
  ["tasks", "Задачи по этапам"],
  ["plan", "Роадмап"],
  ["milestones", "Вехи"],
  ["ideas", "Бэклог идей"],
  ["new", "Новая задача"],
  ["ask", "Вопрос ИИ-консультанту"],
  ["find", "Поиск"],
  ["team", "Команда"],
  ["sync", "Синхронизация с Notion"],
  ["help", "Что умеет бот"],
];

export function keyboard(kb: Btn[][]): unknown {
  if (!kb || !kb.length) return undefined;
  return {
    inline_keyboard: kb.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: (b.data || "").slice(0, 64) }))),
  };
}

export class TelegramApi {
  calls = 0;
  botUsername?: string;
  private token: string;
  private fetchFn: FetchFn;

  constructor(token: string, fetchFn: FetchFn = (i, init) => fetch(i, init)) {
    this.token = token;
    this.fetchFn = fetchFn;
  }

  async call(method: string, payload: Record<string, unknown>): Promise<{ ok: boolean; description?: string; result?: any }> {
    this.calls += 1;
    const r = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data: any = await r.json();
    if (!data.ok) console.warn(`telegram ${method} failed: ${data.description}`);
    return data;
  }

  sendMessage(chatId: number, text: string, kb?: Btn[][], replyTo?: number) {
    return this.call("sendMessage", {
      chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard(kb || []),
      reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
    });
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
    return this.call("setWebhook", { url, secret_token: secret || undefined, allowed_updates: ["message", "callback_query"] });
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
    return this.call("setMyCommands", { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
  }
}

export async function sendNotices(tg: TelegramApi, notices: Notice[]): Promise<void> {
  for (const n of notices) {
    try {
      const r = await tg.sendMessage(n.chatId, n.text, n.kb);
      if (!r.ok) console.warn("notice failed", n.chatId, r.description);   // user never opened the bot, blocked it…
    } catch (e) {
      console.warn("notice failed", n.chatId, String(e));
    }
  }
}

const who = (u: any): Who => ({ id: u.id, name: u.first_name || u.username || String(u.id), username: u.username || "" });

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

export interface UpdateOptions {
  /** Speech-to-text for voice messages; absent → voice is not supported. */
  transcribe?: (audio: ArrayBuffer) => Promise<string>;
}

/** Route one Telegram update into the App and deliver the result. */
export async function handleUpdate(update: any, app: App, tg: TelegramApi, opts: UpdateOptions = {}): Promise<void> {
  if (update.callback_query) {
    const cb = update.callback_query;
    const msg = cb.message;
    const chatId: number = msg ? msg.chat.id : cb.from.id;
    const res = await app.onCallback(who(cb.from), chatId, cb.data || "");
    await tg.answerCallback(cb.id, res.toast, !!res.alert);
    if (res.screen && msg) {
      if (res.newMessage) await tg.sendMessage(chatId, res.screen.text, res.screen.kb);
      else {
        const r = await tg.editMessage(chatId, msg.message_id, res.screen.text, res.screen.kb);
        if (!r.ok && !(r.description || "").includes("not modified")) await tg.sendMessage(chatId, res.screen.text, res.screen.kb);
      }
    }
    await sendNotices(tg, res.notices);
    return;
  }

  const msg = update.message;
  console.log("update", JSON.stringify({ id: update.update_id, chat: msg?.chat?.type, text: msg?.chat?.type === "private" && typeof msg?.text === "string" ? msg.text.slice(0, 60) : undefined, voice: !!msg?.voice, keys: Object.keys(msg || update) }));
  if (!msg || !msg.from) return;
  const chatId: number = msg.chat.id;
  const isPrivate = msg.chat.type === "private";
  let text: string | undefined = typeof msg.text === "string" ? msg.text : undefined;
  let prefix = "";

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
    prefix = `🎙 <i>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</i>\n\n`;
    console.log("voice", isPrivate ? "private" : "group", `${text.length} chars`);
  }
  if (typeof text !== "string") return;

  let res: Result | null;
  let replyTo: number | undefined;
  if (text.startsWith("/")) {
    const [head] = text.split(/\s+/);
    const cmd = head.slice(1).split("@")[0].toLowerCase();
    const mention = head.includes("@") ? head.split("@")[1] : "";
    if (mention && tg.botUsername && mention.toLowerCase() !== tg.botUsername.toLowerCase()) return;   // command for another bot
    if (cmd === "start" && !isPrivate) {
      await tg.sendMessage(chatId, "Напиши мне в личку /start, чтобы попасть в команду.");
      return;
    }
    if (cmd === "ask" && app.askFn) await tg.typing(chatId);
    res = await app.onCommand(who(msg.from), chatId, isPrivate, cmd, text.slice(head.length).trim());
  } else if (!isPrivate) {
    // In a group the bot answers only when addressed: @mention or a reply to its message.
    const me = (await tg.username()).toLowerCase();
    const mentioned = !!me && text.toLowerCase().includes("@" + me);
    const r = msg.reply_to_message?.from;
    const replyToBot = !!r?.is_bot && (!me || (r.username || "").toLowerCase() === me);
    const byNick = stripNickname(text);
    if (!mentioned && !replyToBot && byNick === null) return;
    if (voiceInGroup && byNick === null && !replyToBot) return;
    let q = me ? text.replace(new RegExp("@" + me, "ig"), " ").replace(/\s+/g, " ").trim() : text;
    if (byNick !== null && !mentioned) q = byNick;
    if (app.askFn) await tg.typing(chatId);
    res = await app.onGroupText(who(msg.from), chatId, q);
    replyTo = msg.message_id;
  } else {
    if (app.askFn && !prefix) await tg.typing(chatId);
    res = await app.onText(who(msg.from), chatId, isPrivate, text);
  }
  console.log("result", JSON.stringify({ screen: res ? res.screen?.text.slice(0, 80) : null, notices: res?.notices.length }));
  if (!res) return;
  if (res.screen) await tg.sendMessage(chatId, prefix + res.screen.text, res.screen.kb, replyTo);
  await sendNotices(tg, res.notices);
}
