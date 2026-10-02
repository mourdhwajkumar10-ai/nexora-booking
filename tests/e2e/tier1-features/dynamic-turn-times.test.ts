import { describe, it, expect } from 'vitest';
import {
  resolveTurnMinutes,
  DEFAULT_TURN_RULES,
  DEFAULT_TURN_MINUTES,
  type TurnRule,
  type Daypart,
} from '../helpers/oracle';

describe('Tier 1: Feature Coverage — Dynamic Party-Size Turn Times (F-BR05)', () => {
  const seedRules: ReadonlyArray<TurnRule> = DEFAULT_TURN_RULES.map((r, i) => ({
    ...r,
    id: `rule-seed-${i + 1}`,
  }));

  it('resolves 1-2 covers to 75 minutes by default', () => {
    expect(resolveTurnMinutes(seedRules, { partySize: 1, daypart: 'dinner' })).toBe(75);
    expect(resolveTurnMinutes(seedRules, { partySize: 2, daypart: 'dinner' })).toBe(75);
    expect(resolveTurnMinutes(seedRules, { partySize: 2, daypart: 'lunch' })).toBe(75);
  });

  it('resolves 3-4 covers to 90 minutes by default', () => {
    expect(resolveTurnMinutes(seedRules, { partySize: 3, daypart: 'dinner' })).toBe(90);
    expect(resolveTurnMinutes(seedRules, { partySize: 4, daypart: 'dinner' })).toBe(90);
    expect(resolveTurnMinutes(seedRules, { partySize: 4, daypart: 'brunch' })).toBe(90);
  });

  it('resolves 5+ covers to 120 minutes by default', () => {
    expect(resolveTurnMinutes(seedRules, { partySize: 5, daypart: 'dinner' })).toBe(120);
    expect(resolveTurnMinutes(seedRules, { partySize: 6, daypart: 'dinner' })).toBe(120);
    expect(resolveTurnMinutes(seedRules, { partySize: 10, daypart: 'dinner' })).toBe(120);
    expect(resolveTurnMinutes(seedRules, { partySize: 20, daypart: 'dinner' })).toBe(120);
  });

  it('prefers higher specificity score (daypart + area > daypart > area > global)', () => {
    const customRules: ReadonlyArray<TurnRule> = [
      { id: 'r-global', partyMin: 2, partyMax: 4, daypart: null, diningAreaId: null, minutes: 90 },
      { id: 'r-patio', partyMin: 2, partyMax: 4, daypart: null, diningAreaId: 'area-patio', minutes: 80 },
      { id: 'r-dinner', partyMin: 2, partyMax: 4, daypart: 'dinner', diningAreaId: null, minutes: 100 },
      { id: 'r-dinner-patio', partyMin: 2, partyMax: 4, daypart: 'dinner', diningAreaId: 'area-patio', minutes: 85 },
    ];

    // Matches r-dinner-patio (score 3: daypart 2 + area 1)
    expect(
      resolveTurnMinutes(customRules, { partySize: 3, daypart: 'dinner', diningAreaId: 'area-patio' })
    ).toBe(85);

    // Matches r-dinner (score 2: daypart 2)
    expect(
      resolveTurnMinutes(customRules, { partySize: 3, daypart: 'dinner', diningAreaId: 'area-main' })
    ).toBe(100);

    // Matches r-patio (score 1: area 1)
    expect(
      resolveTurnMinutes(customRules, { partySize: 3, daypart: 'lunch', diningAreaId: 'area-patio' })
    ).toBe(80);

    // Matches r-global (score 0)
    expect(
      resolveTurnMinutes(customRules, { partySize: 3, daypart: 'lunch', diningAreaId: 'area-main' })
    ).toBe(90);
  });

  it('breaks ties by narrower party range when specificity scores are equal', () => {
    const customRules: ReadonlyArray<TurnRule> = [
      { id: 'r-broad', partyMin: 2, partyMax: 8, daypart: 'dinner', diningAreaId: null, minutes: 110 },
      { id: 'r-narrow', partyMin: 4, partyMax: 5, daypart: 'dinner', diningAreaId: null, minutes: 95 },
    ];

    // For party of 4, both have score 2, but r-narrow has span 1 vs r-broad span 6
    expect(
      resolveTurnMinutes(customRules, { partySize: 4, daypart: 'dinner' })
    ).toBe(95);
  });

  it('falls back to venue default turn minutes when no rule matches', () => {
    const limitedRules: ReadonlyArray<TurnRule> = [
      { id: 'r-1', partyMin: 2, partyMax: 4, daypart: 'dinner', diningAreaId: null, minutes: 90 },
    ];

    // Party of 6 has no matching rule
    expect(
      resolveTurnMinutes(limitedRules, { partySize: 6, daypart: 'dinner' }, 85)
    ).toBe(85);

    // Default fallback when omitted is DEFAULT_TURN_MINUTES (90)
    expect(
      resolveTurnMinutes(limitedRules, { partySize: 6, daypart: 'dinner' })
    ).toBe(DEFAULT_TURN_MINUTES);
  });
});
