// Problems are told to the admins in private chat, at most once per `everyMs` per kind of problem.
import type { Clock } from "./config.ts";
import type { Notice } from "./app.ts";
import type { Storage } from "./storage.ts";
import { esc } from "./texts.ts";

export async function adminAlert(st: Storage, clock: Clock, key: string, text: string, everyMs = 6 * 3600_000): Promise<Notice[]> {
  const now = clock().getTime();
  const last = (await st.kvGet<number>(`alert:${key}`)) || 0;
  if (now - last < everyMs) return [];
  const admins = (await st.members()).filter((m) => m.admin && m.approved);
  if (!admins.length) return [];
  await st.kvSet(`alert:${key}`, now);
  return admins.map((a) => ({ chatId: a.tg_id, text: `⚠️ <b>Бот: нужна проверка</b>\n${esc(text)}`, kb: [] }));
}

/** Count of errors of a kind for today (MSK date passed in). */
export async function countError(st: Storage, kind: string, date: string): Promise<number> {
  const k = `err:${kind}:${date}`;
  const n = ((await st.kvGet<number>(k)) || 0) + 1;
  await st.kvSet(k, n);
  return n;
}

export interface Health { lastSyncMs: number | null; syncFails: number; webhook?: { pending_update_count?: number; last_error_date?: number; last_error_message?: string; url?: string }; aiErrors: number; jobErrors: number }

/** Human-readable problems; empty when all is well. */
export function problems(h: Health, nowMs: number, notionOn: boolean): string[] {
  const out: string[] = [];
  if (notionOn) {
    if (h.lastSyncMs === null) out.push("Синхронизация с Notion ещё ни разу не прошла успешно.");
    else if (nowMs - h.lastSyncMs > 2 * 3600_000) out.push(`Notion не синхронизировался ${Math.round((nowMs - h.lastSyncMs) / 3600_000)} ч. Проверь, не отозван ли токен и открыт ли доступ к базам.`);
    if (h.syncFails >= 3) out.push(`Синхронизация падает ${h.syncFails} раз подряд.`);
  }
  if (h.webhook) {
    if (!h.webhook.url) out.push("Вебхук Telegram не установлен — бот не получает сообщения. Перезапусти деплой.");
    if ((h.webhook.pending_update_count || 0) > 20) out.push(`В очереди Telegram ${h.webhook.pending_update_count} необработанных сообщений.`);
    if (h.webhook.last_error_date && nowMs / 1000 - h.webhook.last_error_date < 24 * 3600) out.push(`Telegram сообщал об ошибке вебхука: ${h.webhook.last_error_message || "без описания"}.`);
  }
  if (h.aiErrors >= 3) out.push(`ИИ-консультант ошибся ${h.aiErrors} раз за сутки — проверь баланс Anthropic.`);
  if (h.jobErrors) out.push(`Плановые рассылки падали ${h.jobErrors} раз за сутки.`);
  return out;
}
