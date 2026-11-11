// «Живая доска» — a Telegram widget (Bot API 10.4) in the private chat: progress, my tasks with a ✓ button,
// the next suggested task with «Взять». The widget has no network; it asks the bot with widget queries:
//   "r"          refresh (sent automatically when the widget appears on screen)
//   "d:<code>"   mark my task done
//   "t:<code>"   take the suggested task
// State lives in the message's chat_data (≤ 1024 bytes of JSON) and is also returned in each answer.
import { daysBetween, msk } from "./config.ts";
import type { App, Notice } from "./app.ts";
import * as logic from "./logic.ts";
import { isDone, shortId } from "./models.ts";
import type { Member } from "./models.ts";
import { ActionError } from "./service.ts";
import type { TelegramApi } from "./telegram.ts";

export const BOARD_HTML = `<style>
body{margin:0;padding:10px 12px 4px;font:15px system-ui,sans-serif}
.h{display:flex;justify-content:space-between;align-items:baseline}
.b{height:8px;border-radius:4px;background:var(--tg-theme-secondary-bg-color);overflow:hidden;margin:6px 0 4px}
.b i{display:block;height:100%;width:0;background:var(--tg-theme-button-color);transition:width .4s}
.m{color:var(--tg-theme-hint-color);font-size:13px}
.r{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--tg-theme-section-separator-color)}
.r span{flex:1}
.e{color:var(--tg-theme-destructive-text-color);font-size:13px}
button{padding:4px 12px;min-width:44px}
</style>
<div class="h"><b>TheBearLab</b><span class="m" id="d"></span></div>
<div class="b"><i id="p"></i></div>
<div class="m" id="s"></div>
<div id="l"></div>
<div id="n"></div>
<div class="m" id="x"></div>
<script>
var W=window.TelegramWidget,S=null,$=function(i){return document.getElementById(i)};
function el(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e}
function clear(e){while(e.firstChild)e.removeChild(e.firstChild)}
function set(v){try{var o=typeof v=="string"?JSON.parse(v):v;if(o&&(!S||(o.v||0)>=(S.v||0)))S=o}catch(e){}draw()}
function row(label,meta,metaCls,btn,q){var r=el("div","r");r.appendChild(el("span","",label));if(meta)r.appendChild(el("small",metaCls,meta));
var b=el("button","",btn);b.addEventListener("click",function(){go(q,b)});r.appendChild(b);return r}
function draw(){var l=$("l"),n=$("n");clear(l);clear(n);
if(!S){$("s").textContent="Загружаю…";return}
$("d").textContent=S.d>0?"до запуска "+S.d+" дн.":"";$("p").style.width=S.p+"%";
$("s").textContent="Готово "+S.p+"% · серия "+S.s+" дн."+(S.o?" · просрочено "+S.o:"");
if(!S.t.length)l.appendChild(el("p","m","На тебе нет открытых задач"));
S.t.forEach(function(t){l.appendChild(row(t[3]+" "+t[1],t[2],t[4]?"e":"m","✓","d:"+t[0]))});
if(S.n)n.appendChild(row("Дальше: "+S.n[1],S.n[2],"m","Взять","t:"+S.n[0]));
$("x").textContent=S.u?"обновлено "+S.u:""}
function go(q,b){if(b){b.disabled=true;b.textContent="…"}
W.request(q).then(function(a){if(a.result)set(a.result);else draw()},function(e){if(b){b.disabled=false;b.textContent="!"}$("x").textContent="Не получилось: "+(e&&e.code||"ошибка")})}
W.onEvent("chatDataChanged",function(){set(W.chatData)});
set(W.chatData);go("r");
</script>`;

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The board state for one person, kept under 1024 bytes. */
export async function boardState(app: App, m: Member): Promise<string> {
  const today = app.today();
  const st = app.st;
  const tasks = await st.tasks();
  const [, , pct] = logic.progress(tasks);
  const mine = tasks.filter((t) => t.assignee_tg === m.tg_id && !isDone(t))
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  const next = logic.suggest(tasks, await st.milestones(), null, today, 1)[0];
  const due = (d: string | null): string => {
    if (!d) return "";
    const n = daysBetween(today, d);
    return n < 0 ? `−${-n} дн.` : n === 0 ? "сегодня" : n === 1 ? "завтра" : `${d.slice(8, 10)}.${d.slice(5, 7)}`;
  };
  const base = {
    v: Date.now(), p: pct, d: logic.daysToLaunch(await st.milestones(), today), s: logic.streak(await st.days(), today),
    o: logic.overdue(tasks, today).length, u: msk(app.clock()).iso.slice(11, 16),
    n: next ? [shortId(next.task.id), cut(next.task.title, 26), due(next.task.due)] : null,
  };
  for (const [count, len] of [[5, 28], [4, 24], [3, 20], [2, 18], [1, 16], [0, 0]]) {
    const t = mine.slice(0, count).map((x) => [shortId(x.id), cut(x.title, len), due(x.due), x.status === "В работе" ? "🔵" : "⚪", x.due && x.due < today ? 1 : 0]);
    const json = JSON.stringify({ ...base, t });
    if (new TextEncoder().encode(json).length <= 1000) return json;
  }
  return JSON.stringify({ ...base, n: null, t: [] });
}

export async function sendBoard(app: App, tg: TelegramApi, chatId: number, m: Member): Promise<boolean> {
  const r = await tg.call("sendWidget", {
    chat_id: chatId, html: BOARD_HTML, chat_data: await boardState(app, m), allow_queries: true,
    caption: "Живая доска TheBearLab: прогресс и твои задачи. Отметь ✓, когда закончишь.",
  });
  if (r.ok) await app.st.kvSet(`board:${chatId}`, r.result.message_id);
  return r.ok;
}

/** Answer a widget_query from the board; returns notices for the team (e.g. «задача закрыта»). */
export async function handleBoardQuery(app: App, tg: TelegramApi, q: any): Promise<Notice[]> {
  const notices: Notice[] = [];
  const m = await app.memberOf({ id: q.from.id, name: q.from.first_name || "", username: q.from.username || "" });
  if (!m) {
    await tg.call("answerWidgetQuery", { widget_query_id: q.id, data: "" });
    return notices;
  }
  const data = String(q.data || "");
  try {
    const [act, code] = data.split(":");
    if (act === "d" || act === "t") {
      const t = (await app.st.tasks()).find((x) => shortId(x.id) === code);
      if (!t) throw new ActionError("задача не найдена");
      const prev = t.assignee_tg;
      app.svc.recent = [];
      if (act === "d") await app.svc.setStatus(t, m, "Готово");
      else await app.svc.take(t, m);
      notices.push(...(await app.noticesFor(m, t, prev)));
    }
  } catch (e) {
    console.warn("board action failed", String(e));
  }
  const state = await boardState(app, m);
  await tg.call("answerWidgetQuery", { widget_query_id: q.id, data: state });
  if (q.chat && q.message_id && data !== "r") {
    await tg.call("editMessageWidgetData", { chat_id: q.chat.id, message_id: q.message_id, chat_data: state });
  }
  return notices;
}
