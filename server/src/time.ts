import { ROLLOVER_HOUR } from "./srs.ts";

/**
 * Timestamps are stored as RFC 3339 in UTC with whole seconds
 * ("2026-01-01T12:00:00Z"), which sorts correctly as text. The format must
 * stay exactly this, since queries compare these strings.
 */
export function toTimestamp(time: Date): string {
  const secs = Math.floor(time.getTime() / 1000) * 1000;
  return new Date(secs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function nowString(): string {
  return toTimestamp(new Date());
}

export function parseTime(value: string): Date {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? new Date() : new Date(ms);
}

// Days are counted in the server's local time zone (set TZ to change it),
// starting at the rollover hour like Anki's.

const DAY_MS = 86_400_000;

/** The day `time` belongs to, as a day number (days since 1970-01-01). */
function ankiDay(time: Date): number {
  const shifted = new Date(time.getTime() - ROLLOVER_HOUR * 3_600_000);
  return Date.UTC(shifted.getFullYear(), shifted.getMonth(), shifted.getDate()) / DAY_MS;
}

/** The local time at which the given day starts. */
function rolloverOf(day: number): Date {
  const date = new Date(day * DAY_MS);
  // A DST jump that skips the rollover hour lands on the next valid time.
  return new Date(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    ROLLOVER_HOUR,
  );
}

/**
 * Today's date in Anki's sense: the day changes at the rollover hour (4am),
 * not at midnight. Used to decide whether an "increase today's limit" bump
 * still applies.
 */
export function todayKey(now: Date = new Date()): string {
  return new Date(ankiDay(now) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The start of today (the last rollover), used as the cutoff for
 * "studied/reviewed today". Like Anki, daily limits reset at the rollover
 * rather than over a rolling 24 hours.
 */
export function dayStart(now: Date = new Date()): Date {
  return dayStartIn(0, now);
}

/** The rollover `days` days from today. Review cards are due from then. */
export function dayStartIn(days: number, now: Date = new Date()): Date {
  return rolloverOf(ankiDay(now) + days);
}

/** Whole days from `time`'s day to today (negative if `time` is on a later day). */
export function daysSince(time: Date, now: Date = new Date()): number {
  return ankiDay(now) - ankiDay(time);
}
