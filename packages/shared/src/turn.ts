/**
 * BR-05 Turn-time resolution.
 * A rule matches when partyMin <= partySize <= partyMax and its daypart / diningAreaId
 * are either null (wildcard) or equal to the query.
 * Most specific wins: score = (daypart set ? 2 : 0) + (area set ? 1 : 0).
 * Ties: narrower party range, then lower id (string compare). Fallback when nothing matches.
 */
export type Daypart = 'breakfast' | 'brunch' | 'lunch' | 'dinner' | 'late_night';

export interface TurnRule {
  id: string;
  partyMin: number;
  partyMax: number;
  daypart: Daypart | null;
  diningAreaId: string | null;
  minutes: number;
}

export interface TurnQuery {
  partySize: number;
  daypart: Daypart;
  diningAreaId?: string | null;
}

export const DEFAULT_TURN_MINUTES = 90;

/** Seed rules created for every new venue (spec defaults). */
export const DEFAULT_TURN_RULES: ReadonlyArray<Omit<TurnRule, 'id'>> = [
  { partyMin: 1, partyMax: 2, daypart: null, diningAreaId: null, minutes: 75 },
  { partyMin: 3, partyMax: 4, daypart: null, diningAreaId: null, minutes: 90 },
  { partyMin: 5, partyMax: 50, daypart: null, diningAreaId: null, minutes: 120 },
];

function score(r: TurnRule): number {
  return (r.daypart !== null ? 2 : 0) + (r.diningAreaId !== null ? 1 : 0);
}

export function resolveTurnMinutes(rules: ReadonlyArray<TurnRule>, q: TurnQuery, fallback = DEFAULT_TURN_MINUTES): number {
  const area = q.diningAreaId ?? null;
  const matches = rules.filter(
    (r) =>
      r.partyMin <= q.partySize &&
      q.partySize <= r.partyMax &&
      (r.daypart === null || r.daypart === q.daypart) &&
      (r.diningAreaId === null || r.diningAreaId === area),
  );
  if (matches.length === 0) return fallback;
  matches.sort((a, b) => {
    const s = score(b) - score(a);
    if (s !== 0) return s;
    const w = a.partyMax - a.partyMin - (b.partyMax - b.partyMin);
    if (w !== 0) return w;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return matches[0]!.minutes;
}

export interface TurnRuleIssue {
  code: 'INVALID_RANGE' | 'INVALID_MINUTES' | 'OVERLAP';
  ruleIds: string[];
}

/**
 * Validation used by the settings API: ranges must be sane and rules with the SAME
 * (daypart, diningAreaId) key must not overlap in party size.
 */
export function validateTurnRules(rules: ReadonlyArray<TurnRule>): TurnRuleIssue[] {
  const issues: TurnRuleIssue[] = [];
  for (const r of rules) {
    if (!Number.isInteger(r.partyMin) || !Number.isInteger(r.partyMax) || r.partyMin < 1 || r.partyMax < r.partyMin || r.partyMax > 50) {
      issues.push({ code: 'INVALID_RANGE', ruleIds: [r.id] });
    }
    if (!Number.isInteger(r.minutes) || r.minutes < 15 || r.minutes > 480 || r.minutes % 5 !== 0) {
      issues.push({ code: 'INVALID_MINUTES', ruleIds: [r.id] });
    }
  }
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i]!;
      const b = rules[j]!;
      if (a.daypart !== b.daypart || a.diningAreaId !== b.diningAreaId) continue;
      if (a.partyMin <= b.partyMax && b.partyMin <= a.partyMax) issues.push({ code: 'OVERLAP', ruleIds: [a.id, b.id] });
    }
  }
  return issues;
}
