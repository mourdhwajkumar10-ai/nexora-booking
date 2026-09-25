/**
 * Injectable clock. ALL business logic must use `clock.now()` (not `new Date()` / SQL now())
 * so tests can time-travel (grace periods, triage timeouts, dwell alerts).
 */
let offsetMs = 0;
let frozen: number | null = null;

export const clock = {
  now(): Date {
    return new Date(frozen ?? Date.now() + offsetMs);
  },
  /** Freeze time at a specific instant (tests). */
  set(d: Date | string): void {
    frozen = new Date(d).getTime();
  },
  /** Move time forward by N minutes (tests). */
  advanceMinutes(mins: number): void {
    if (frozen !== null) frozen += mins * 60_000;
    else offsetMs += mins * 60_000;
  },
  reset(): void {
    offsetMs = 0;
    frozen = null;
  },
};
