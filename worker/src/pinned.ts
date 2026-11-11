// A pinned «live summary» in the team group: one message edited in place whenever the picture changes.
import { msk } from "./config.ts";
import type { Clock } from "./config.ts";
import { getGroupPrefs } from "./prefs.ts";
import * as rich from "./rich.ts";
import type { Storage } from "./storage.ts";
import type { TelegramApi } from "./telegram.ts";
import * as texts from "./texts.ts";

interface PinState { chat: number; id: number; hash: string }

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Creates (when asked with kv pin_wanted), or edits the pinned summary when its content changed. */
export async function refreshPinned(st: Storage, tg: TelegramApi, clock: Clock): Promise<string> {
  const group = Number(await st.kvGet("group_chat"));
  if (!group || !(await getGroupPrefs(st)).pinned) return "off";
  const state = await st.kvGet<PinState>("pinned");
  const wanted = await st.kvGet("pin_wanted");
  if (!wanted && (!state || state.chat !== group)) return "none";
  const t = msk(clock());
  const r = await rich.digest(st, t.date, "Живая сводка");
  const html = await texts.teamDigest(st, t.date);
  const h = hash(r);
  if (state && state.chat === group && state.hash === h && !wanted) return "same";
  const stamp = { md: `\n\n_обновлено ${t.iso.slice(11, 16)} МСК_`, html: `\n\n<i>обновлено ${t.iso.slice(11, 16)} МСК</i>` };
  const screen = { text: html + stamp.html, kb: [[{ text: "Свободные задачи", data: "go:free" }, { text: "Мой кабинет", data: "go:my" }]], rich: r + stamp.md };
  if (state && state.chat === group && !wanted) {
    const e = await tg.editScreen(screen, group, state.id);
    if (e.ok) { await st.kvSet("pinned", { ...state, hash: h }); return "edited"; }
  }
  await st.kvDel("pin_wanted");
  const sent: any = await tg.sendScreen(screen, { chatId: group });
  if (!sent.ok) return "send failed";
  const id = sent.result.message_id;
  await st.kvSet("pinned", { chat: group, id, hash: h });
  const p = await tg.pin(group, id);
  if (!p.ok) {
    await tg.sendMessage(group, "Чтобы закрепить живую сводку, сделай меня администратором чата с правом «Закреплять сообщения» и отправь /pin.");
    return "pin failed";
  }
  return "pinned";
}
