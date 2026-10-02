/**
 * BR-20 Send-time compliance gate, BR-21 quiet hours.
 * Every outbound message passes evaluateSend() at SEND time (not audience-build time).
 */
import { addDays, localToInstant, toLocalParts } from './time';

export type Channel = 'sms' | 'email';
export type Category = 'transactional' | 'marketing' | 'feedback';

export type ConsentType =
  | 'sms_marketing'
  | 'email_marketing'
  | 'push_marketing'
  | 'sms_all'
  | 'email_feedback'
  | 'presence_recognition'
  | 'allergy_sharing'
  | 'financial_incentive_loyalty'
  | 'financial_incentive_wifi'
  | 'wifi_terms';

export type ConsentStatus = 'granted' | 'revoked';

export interface QuietHours {
  /** inclusive, wall clock minutes */
  startMinute: number;
  /** exclusive */
  endMinute: number;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { startMinute: 9 * 60, endMinute: 20 * 60 };
/** Federal TCPA quiet hours: 9 PM (21:00) to 8 AM (08:00) local time. Window open 08:00 to 21:00. */
export const TCPA_QUIET_HOURS: QuietHours = { startMinute: 8 * 60, endMinute: 21 * 60 };

/** Used when the recipient's time zone is unknown: the window must be open in BOTH zones. */
export const UNKNOWN_TZ_ZONES: ReadonlyArray<string> = ['America/New_York', 'America/Los_Angeles'];

export const FREQUENCY_CAPS = {
  sms: { per24h: 1, per7d: 3 },
  email: { per24h: Number.POSITIVE_INFINITY, per7d: 3 },
} as const;

export interface SendInput {
  channel: Channel;
  category: Category;
  /** consent state rows for (sender, contact); missing key = never granted */
  consents: Partial<Record<ConsentType, ConsentStatus>>;
  /** true if the contact is in suppressions for this sender and (channel or 'all') */
  suppressed: boolean;
  nowMs: number;
  /** recipient IANA zone if known (e.g. venue zone for venue sends), else null */
  recipientTimeZone: string | null;
  /** marketing/feedback messages already SENT to this contact by this sender */
  sentLast24h: number;
  sentLast7d: number;
  quietHours?: QuietHours;
}

export type SendDecision =
  | { decision: 'send' }
  | { decision: 'defer'; reason: 'quiet_hours'; sendAtMs: number }
  | { decision: 'block'; reason: 'suppressed' | 'sms_stopped' | 'no_consent' | 'revoked' | 'frequency_cap' };

function inWindow(nowMs: number, zones: ReadonlyArray<string>, qh: QuietHours): boolean {
  return zones.every((tz) => {
    const m = toLocalParts(nowMs, tz).minuteOfDay;
    return m >= qh.startMinute && m < qh.endMinute;
  });
}

/** Next instant >= now at which the window is open in all zones. */
export function nextWindowOpen(nowMs: number, zones: ReadonlyArray<string>, qh: QuietHours = DEFAULT_QUIET_HOURS): number {
  if (inWindow(nowMs, zones, qh)) return nowMs;
  const candidates: number[] = [];
  for (const tz of zones) {
    const today = toLocalParts(nowMs, tz).date;
    for (let k = 0; k <= 2; k++) {
      const t = localToInstant(addDays(today, k), qh.startMinute, tz).getTime();
      if (t > nowMs) candidates.push(t);
    }
  }
  candidates.sort((a, b) => a - b);
  const found = candidates.find((t) => inWindow(t, zones, qh));
  if (found === undefined) throw new Error('No open window within 48 hours');
  return found;
}

export function evaluateSend(input: SendInput): SendDecision {
  const qh = input.quietHours ?? DEFAULT_QUIET_HOURS;
  if (input.suppressed) return { decision: 'block', reason: 'suppressed' };
  if (input.channel === 'sms' && input.consents.sms_all === 'revoked') return { decision: 'block', reason: 'sms_stopped' };
  if (input.category === 'transactional') return { decision: 'send' };

  if (input.channel === 'email' && input.category === 'feedback') {
    if (input.consents.email_feedback === 'revoked' || input.consents.email_marketing === 'revoked') return { decision: 'block', reason: 'revoked' };
  } else {
    const key: ConsentType = input.channel === 'sms' ? 'sms_marketing' : 'email_marketing';
    const state = input.consents[key];
    if (state === 'revoked') return { decision: 'block', reason: 'revoked' };
    if (state !== 'granted') return { decision: 'block', reason: 'no_consent' };
  }

  const caps = FREQUENCY_CAPS[input.channel];
  if (input.sentLast24h >= caps.per24h || input.sentLast7d >= caps.per7d) return { decision: 'block', reason: 'frequency_cap' };

  if (input.channel === 'sms') {
    const zones = input.recipientTimeZone ? [input.recipientTimeZone] : UNKNOWN_TZ_ZONES;
    const openAt = nextWindowOpen(input.nowMs, zones, qh);
    if (openAt > input.nowMs) return { decision: 'defer', reason: 'quiet_hours', sendAtMs: openAt };
  }
  return { decision: 'send' };
}

/** STOP-family keywords (carrier standard + common variants). Case-insensitive, whole message. */
export const STOP_KEYWORDS: ReadonlyArray<string> = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'OPT OUT', 'OPT-OUT'];
export const START_KEYWORDS: ReadonlyArray<string> = ['START', 'UNSTOP', 'YES'];
export const HELP_KEYWORDS: ReadonlyArray<string> = ['HELP', 'INFO'];

const NATURAL_OPT_OUT = [
  /\b(stop|quit|cease|don'?t|do not|no more)\b.*\b(text|txt|message|msg|sms|contact|messaging|texting)/i,
  /\bremove me\b/i,
  /\bunsubscribe\b/i,
  /\bleave me alone\b/i,
  /\bwrong number\b/i,
  /\bopt(\s|-)?out\b/i,
];

export type InboundIntent = 'stop' | 'start' | 'help' | 'opt_out_natural_language' | 'other';

/**
 * Classifies an inbound SMS. Natural-language opt-outs are treated as STOP (TCPA "any reasonable means").
 * When unsure, callers should treat 'opt_out_natural_language' exactly like 'stop'.
 */
export function classifyInboundSms(body: string): InboundIntent {
  const s = body.trim().replace(/[.!]+$/, '').toUpperCase();
  if (STOP_KEYWORDS.includes(s)) return 'stop';
  if (START_KEYWORDS.includes(s)) return 'start';
  if (HELP_KEYWORDS.includes(s)) return 'help';
  if (NATURAL_OPT_OUT.some((re) => re.test(body))) return 'opt_out_natural_language';
  return 'other';
}
