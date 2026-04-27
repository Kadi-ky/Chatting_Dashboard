/**
 * Persona sleep-hours gate. The persona is "asleep" during a configured window
 * in the persona's local timezone. Replies scheduled inside the window are
 * deferred to morning + jitter so the fan doesn't see instant 3am responses.
 *
 * Defaults match the placeholder persona (Austin, 3am–11am CT). Per-persona
 * overrides come from account config in a later phase.
 */

export interface SleepSchedule {
  /** IANA timezone, e.g. "America/Chicago". */
  tz: string;
  /** Sleep start (local hour 0-23). */
  startHour: number;
  /** Sleep end (local hour 0-23). End < start means the window crosses midnight. */
  endHour: number;
  /** Jitter in minutes on the wake time so every morning is not identical. */
  jitterMinutes: number;
}

export const DEFAULT_SLEEP: SleepSchedule = {
  tz: "America/Chicago",
  startHour: 3,
  endHour: 11,
  jitterMinutes: 45,
};

export interface SleepDecision {
  /** True if a reply right now would fall inside the sleep window. */
  asleep: boolean;
  /** If asleep, when to wake and reply. Otherwise null. */
  replyAt: Date | null;
  /** Delay in ms from now until replyAt. 0 if awake. */
  delayMs: number;
}

/**
 * Decide whether to defer a reply due to sleep hours. `now` is injectable for tests.
 */
export function sleepDecision(
  schedule: SleepSchedule = DEFAULT_SLEEP,
  now: Date = new Date(),
): SleepDecision {
  // Test override: when LOOP_TEST_MODE=1, treat the persona as always awake so
  // automated test loops don't wait hours for replies. Real prod runs leave it unset.
  if (process.env.LOOP_TEST_MODE === "1") {
    return { asleep: false, replyAt: null, delayMs: 0 };
  }
  const localHour = hourInTimezone(now, schedule.tz);
  const inWindow = isInWindow(localHour, schedule.startHour, schedule.endHour);
  if (!inWindow) return { asleep: false, replyAt: null, delayMs: 0 };

  const wakeAt = nextLocalHour(now, schedule.tz, schedule.endHour);
  const jitterMs = Math.floor(Math.random() * schedule.jitterMinutes * 60_000);
  const replyAt = new Date(wakeAt.getTime() + jitterMs);
  return { asleep: true, replyAt, delayMs: replyAt.getTime() - now.getTime() };
}

function isInWindow(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  // crosses midnight
  return hour >= start || hour < end;
}

function hourInTimezone(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(d);
  const h = parts.find((p) => p.type === "hour")?.value;
  return h ? parseInt(h, 10) : d.getUTCHours();
}

/**
 * Returns the next absolute Date at which the local hour in the given tz will
 * equal `targetHour`. If the hour is later today, returns today; else tomorrow.
 * Precision is 1 hour (minute is 0); jitter is added by the caller.
 */
function nextLocalHour(now: Date, tz: string, targetHour: number): Date {
  // Compute today's date in the target tz as Y-M-D parts.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const currentLocalHour = parseInt(get("hour"), 10);

  // Build an ISO for today at targetHour local; adjust the day if already past.
  let day = parseInt(d, 10);
  if (currentLocalHour >= targetHour) day += 1;
  const iso = `${y}-${m}-${String(day).padStart(2, "0")}T${String(targetHour).padStart(2, "0")}:00:00`;

  // Use an offset trick: build the date as UTC, then subtract the offset of `tz` at that moment.
  const utc = new Date(`${iso}Z`);
  const offsetMs = timezoneOffsetMs(utc, tz);
  return new Date(utc.getTime() - offsetMs);
}

function timezoneOffsetMs(at: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const asTz = Date.UTC(
    parseInt(get("year"), 10),
    parseInt(get("month"), 10) - 1,
    parseInt(get("day"), 10),
    parseInt(get("hour"), 10),
    parseInt(get("minute"), 10),
    parseInt(get("second"), 10),
  );
  return asTz - at.getTime();
}
