'use client';
/**
 * Server-synchronised clock shared by every live timer in the console.
 * One aligned timeout ticks once per (server) second for all subscribers, instead of one interval
 * per tile. The offset (serverNow - clientNow) is refreshed from `server:time` and payloads.
 */
import { useSyncExternalStore } from 'react';

let offsetMs = 0;
let now = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();

export function setServerTime(iso: string | undefined | null, roundTripMs = 0) {
  if (!iso) return;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return;
  offsetMs = t + roundTripMs / 2 - Date.now();
}

export const getServerOffset = () => offsetMs;
export const serverNow = () => Date.now() + offsetMs;

const floorSecond = (ms: number) => Math.floor(ms / 1000) * 1000;

function schedule() {
  const wait = 1000 - (serverNow() % 1000) + 5;
  timer = setTimeout(() => {
    now = floorSecond(serverNow());
    subscribers.forEach((fn) => fn());
    schedule();
  }, wait);
}

function subscribe(cb: () => void) {
  subscribers.add(cb);
  if (!timer) {
    now = floorSecond(serverNow());
    schedule();
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

function getSnapshot() {
  if (!timer) now = floorSecond(serverNow());
  return now;
}

/** Current server time in ms (whole seconds). Returns 0 during SSR/hydration. */
export function useServerNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
