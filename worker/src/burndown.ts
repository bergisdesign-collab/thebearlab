// Burndown for the Friday report: open tasks per day (from the daily records) against an ideal
// straight line to launch. Rendered by QuickChart as a PNG link (no keys, no server of ours).
import { LAUNCH_DATE, addDays, daysBetween } from "./config.ts";
import type { DayRec } from "./logic.ts";

export interface Burndown { labels: string[]; actual: (number | null)[]; ideal: number[]; remaining: number; perWeekNeeded: number }

export function burndown(days: Record<string, DayRec>, today: string, openNow: number, span = 28): Burndown {
  const start = addDays(today, -(span - 1));
  const labels: string[] = [];
  const actual: (number | null)[] = [];
  for (let i = 0; i < span; i++) {
    const d = addDays(start, i);
    labels.push(`${d.slice(8, 10)}.${d.slice(5, 7)}`);
    const r = days[d];
    actual.push(d === today ? openNow : r && r.total !== undefined ? r.total - r.done : null);
  }
  const first = actual.find((x) => x !== null) ?? openNow;
  const firstIdx = Math.max(0, actual.findIndex((x) => x !== null));
  const toLaunch = Math.max(1, daysBetween(addDays(start, firstIdx), LAUNCH_DATE));
  const ideal = labels.map((_, i) => Math.max(0, Math.round((first - (first * Math.max(0, i - firstIdx)) / toLaunch) * 10) / 10));
  const left = Math.max(1, daysBetween(today, LAUNCH_DATE));
  return { labels, actual, ideal, remaining: openNow, perWeekNeeded: Math.ceil((openNow / left) * 7) };
}

export function chartUrl(b: Burndown): string {
  const cfg = {
    type: "line",
    data: {
      labels: b.labels,
      datasets: [
        { label: "Осталось задач", data: b.actual, borderColor: "#c2410c", backgroundColor: "rgba(194,65,12,0.12)", fill: true, spanGaps: true, pointRadius: 2 },
        { label: "Идеальный темп к запуску", data: b.ideal, borderColor: "#64748b", borderDash: [6, 4], fill: false, pointRadius: 0 },
      ],
    },
    options: { plugins: { title: { display: true, text: "TheBearLab · burndown" } }, scales: { y: { beginAtZero: true } } },
  };
  return "https://quickchart.io/chart?w=700&h=360&bkg=white&v=4&c=" + encodeURIComponent(JSON.stringify(cfg));
}

/** One line for text reports. */
export function burndownLine(b: Burndown): string {
  const known = b.actual.filter((x): x is number => x !== null);
  const weekAgo = b.actual[b.actual.length - 8];
  const delta = weekAgo !== null && weekAgo !== undefined ? weekAgo - b.remaining : null;
  return `Осталось ${b.remaining} задач${delta !== null ? `, за неделю ${delta >= 0 ? "−" + delta : "+" + -delta}` : ""}; чтобы успеть к запуску, нужно закрывать ~${b.perWeekNeeded} в неделю.${known.length < 3 ? " (График наполнится за пару недель.)" : ""}`;
}
