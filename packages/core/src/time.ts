/**
 * Time in JAPAN LIVE.
 *
 * Internally everything is an epoch millisecond value. Display is always Asia/Tokyo.
 * Japan has no daylight saving, so the offset is a constant +09:00 — but we never read
 * the host machine's zone to get there.
 */

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const SECONDS_PER_DAY = 86_400;

/** Calendar fields of an instant, in JST. */
export interface JstParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  /** 0 = Sunday .. 6 = Saturday, in JST. */
  weekday: number;
}

export function toJstParts(epochMs: number): JstParts {
  // Shift into JST then read UTC fields, so the host timezone is never consulted.
  const d = new Date(epochMs + JST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

/** Epoch ms for a JST wall-clock time. Hour may exceed 23 to express a service time. */
export function fromJstParts(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return Date.UTC(year, month - 1, day, hour, minute, second) - JST_OFFSET_MS;
}

export function formatJstClock(epochMs: number, withSeconds = true): string {
  const p = toJstParts(epochMs);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  if (!withSeconds) return `${hh}:${mm}`;
  return `${hh}:${mm}:${String(p.second).padStart(2, "0")}`;
}

export function formatJstDate(epochMs: number): string {
  const p = toJstParts(epochMs);
  return `${p.year}/${String(p.month).padStart(2, "0")}/${String(p.day).padStart(2, "0")}`;
}

/**
 * The hour at which one service day gives way to the next.
 *
 * Trains running at 01:30 belong to the *previous* day's timetable, expressed there as
 * 25:30:00. Japanese rail services generally end before 02:00 and restart around 05:00,
 * so 03:00 is a safe cut.
 */
export const SERVICE_DAY_CUTOVER_HOUR = 3;

export interface ServiceDay {
  /** The date the timetable is keyed by, in JST. */
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday .. 6 = Saturday — the weekday of the service day, not of `now`. */
  weekday: number;
  /** Epoch ms of 00:00:00 JST on that date. Service seconds are measured from here. */
  startEpochMs: number;
}

/**
 * Which service day an instant belongs to.
 *
 * 2026-08-18 01:30 JST is on service day 2026-08-17, at service second 91800 (25:30:00).
 */
export function serviceDayFor(epochMs: number): ServiceDay {
  const p = toJstParts(epochMs);
  let { year, month, day } = p;
  if (p.hour < SERVICE_DAY_CUTOVER_HOUR) {
    const prev = new Date(Date.UTC(year, month - 1, day) - 24 * 60 * 60 * 1000);
    year = prev.getUTCFullYear();
    month = prev.getUTCMonth() + 1;
    day = prev.getUTCDate();
  }
  const startEpochMs = fromJstParts(year, month, day, 0, 0, 0);
  const weekday = new Date(startEpochMs + JST_OFFSET_MS).getUTCDay();
  return { year, month, day, weekday, startEpochMs };
}

/**
 * Seconds since the start of the service day. Exceeds 86400 after midnight, matching
 * how GTFS writes 24:00:00 and beyond.
 */
export function serviceSecondsFor(epochMs: number, day = serviceDayFor(epochMs)): number {
  return Math.floor((epochMs - day.startEpochMs) / 1000);
}

/** Epoch ms for a service second on a given service day. */
export function epochForServiceSeconds(day: ServiceDay, seconds: number): number {
  return day.startEpochMs + seconds * 1000;
}

/**
 * Parse a GTFS time. `25:14:00` is valid and means 01:14 the next calendar morning.
 * Returns null for anything malformed rather than guessing.
 */
export function parseGtfsTime(value: string): number | null {
  const m = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  if (!Number.isFinite(h) || h > 47) return null;
  return h * 3600 + min * 60 + s;
}

/** Render a service second the way a timetable does: 25:14:00, not 01:14:00. */
export function formatServiceTime(seconds: number, withSeconds = false): string {
  if (!Number.isFinite(seconds)) return "--:--";
  const sign = seconds < 0 ? "-" : "";
  const abs = Math.abs(Math.floor(seconds));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const base = `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return withSeconds ? `${base}:${String(s).padStart(2, "0")}` : base;
}

/** Does `serviceId`'s weekday mask include this service day? */
export function serviceRunsOn(mask: number, weekday: number): boolean {
  return (mask & (1 << weekday)) !== 0;
}

export const WEEKDAY_MASK = 0b0111110; // Mon-Fri
export const WEEKEND_MASK = 0b1000001; // Sun, Sat
export const ALL_DAYS_MASK = 0b1111111;
