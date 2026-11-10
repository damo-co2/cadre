/** "in 2 h", "3 min ago", "just now" — coarse relative time for routine rows. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diff = t - now;
  const abs = Math.abs(diff);
  const future = diff > 0;
  const fmt = (n: number, unit: string) => (future ? `in ${n} ${unit}` : `${n} ${unit} ago`);
  if (abs < 45_000) return future ? "in a moment" : "just now";
  const min = Math.round(abs / 60_000);
  if (min < 60) return fmt(min, "min");
  const h = Math.round(abs / 3_600_000);
  if (h < 48) return fmt(h, "h");
  const d = Math.round(abs / 86_400_000);
  if (d < 30) return fmt(d, "d");
  return new Date(t).toLocaleDateString();
}

export function shortTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Tiny cron → English for template previews: "Daily 07:00", "Weekdays 09:00", "Mon, Thu 18:30",
 * "Every 15 minutes", "Every 2 hours", "Monthly on day 1 09:00". Anything else comes back as the raw cron.
 */
export function cronToText(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = f;
  const every = (x: string) => /^\*\/(\d+)$/.exec(x)?.[1];
  const num = (x: string) => (/^\d+$/.test(x) ? Number(x) : null);
  if (mon !== "*") return cron;
  const m = num(min);
  const h = num(hour);
  // "0 11,15 * * 1-5" → "11:00, 15:00"
  const hours = h !== null ? [h] : /^\d+(,\d+)+$/.test(hour) ? hour.split(",").map(Number) : null;
  const hhmm = m !== null && hours ? hours.map((x) => `${String(x).padStart(2, "0")}:${String(m).padStart(2, "0")}`).join(", ") : null;

  if (every(min) && hour === "*" && dom === "*" && dow === "*") return `Every ${every(min)} minutes`;
  if (min === "*" && hour === "*" && dom === "*" && dow === "*") return "Every minute";
  if (m !== null && every(hour) && dom === "*" && dow === "*") return `Every ${every(hour)} hours`;
  if (m !== null && hour === "*" && dom === "*" && dow === "*") return m === 0 ? "Hourly" : `Hourly at :${String(m).padStart(2, "0")}`;
  if (!hhmm) return cron;
  if (dom === "*" && dow === "*") return `Daily ${hhmm}`;
  if (dom === "*") {
    if (dow === "1-5") return `Weekdays ${hhmm}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends ${hhmm}`;
    const days = dayList(dow);
    if (days) return `${days} ${hhmm}`;
    return cron;
  }
  const d = num(dom);
  if (dow === "*" && d !== null) return `Monthly on day ${d} ${hhmm}`;
  return cron;
}

function dayList(dow: string): string | null {
  const out: string[] = [];
  for (const part of dow.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) out.push(DAY_NAMES[i % 7]!);
      continue;
    }
    if (!/^\d$/.test(part)) return null;
    out.push(DAY_NAMES[Number(part) % 7]!);
  }
  return out.length ? out.join(", ") : null;
}
