/**
 * West Africa Time (Africa/Lagos) boundaries. Spec §8.3: the reconciliation
 * cut is 23:59 WAT and the same boundary is used on both sides. WAT is a
 * fixed UTC+1 (no daylight saving), so plain offset arithmetic is exact.
 */
const WAT_OFFSET_MS = 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD of the WAT calendar day containing `at`. */
export function watDate(at: Date): string {
  const shifted = new Date(at.getTime() + WAT_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** [start, end) instants of a WAT calendar day given as YYYY-MM-DD. */
export function watDayBounds(day: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`Invalid WAT date: ${day}`);
  const start = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - WAT_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/** [start, end) instants of a WAT calendar month given as YYYY-MM. */
export function watMonthBounds(period: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m || +m[2] < 1 || +m[2] > 12) throw new Error(`Invalid WAT month: ${period}`);
  const start = new Date(Date.UTC(+m[1], +m[2] - 1, 1) - WAT_OFFSET_MS);
  const end = new Date(Date.UTC(+m[1], +m[2], 1) - WAT_OFFSET_MS);
  return { start, end };
}

/** The WAT day before the one containing `at` (the day a daily job closes). */
export function previousWatDate(at: Date = new Date()): string {
  return watDate(new Date(watDayBounds(watDate(at)).start.getTime() - 1));
}

/** The WAT month before the one containing `at` (the month a monthly job closes). */
export function previousWatMonth(at: Date = new Date()): string {
  const shifted = new Date(at.getTime() + WAT_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const mo = shifted.getUTCMonth(); // 0-based current month = previous month's 1-based number
  return mo === 0 ? `${y - 1}-12` : `${y}-${pad(mo)}`;
}
