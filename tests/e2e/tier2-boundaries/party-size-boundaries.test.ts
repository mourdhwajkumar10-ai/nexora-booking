import { describe, it, expect } from 'vitest';
import {
  resolveTurnMinutes,
  DEFAULT_TURN_RULES,
  DEFAULT_TURN_MINUTES,
  type TurnRule,
} from '../helpers/oracle';

describe('Tier 2: Boundary & Corner Cases — Party Size Limits & Tier Thresholds', () => {
  const seedRules: ReadonlyArray<TurnRule> = DEFAULT_TURN_RULES.map((r, i) => ({
    ...r,
    id: `seed-r-${i + 1}`,
  }));

  it('verifies exact threshold transition from 2 to 3 covers (75m -> 90m)', () => {
    // Upper bound of Tier 1 (1-2 covers)
    expect(resolveTurnMinutes(seedRules, { partySize: 2, daypart: 'dinner' })).toBe(75);
    // Lower bound of Tier 2 (3-4 covers)
    expect(resolveTurnMinutes(seedRules, { partySize: 3, daypart: 'dinner' })).toBe(90);
  });

  it('verifies exact threshold transition from 4 to 5 covers (90m -> 120m)', () => {
    // Upper bound of Tier 2 (3-4 covers)
    expect(resolveTurnMinutes(seedRules, { partySize: 4, daypart: 'dinner' })).toBe(90);
    // Lower bound of Tier 3 (5+ covers)
    expect(resolveTurnMinutes(seedRules, { partySize: 5, daypart: 'dinner' })).toBe(120);
  });

  it('handles minimum party size boundary (1 cover)', () => {
    expect(resolveTurnMinutes(seedRules, { partySize: 1, daypart: 'dinner' })).toBe(75);
  });

  it('handles maximum party size boundary for seed rule (50 covers)', () => {
    expect(resolveTurnMinutes(seedRules, { partySize: 50, daypart: 'dinner' })).toBe(120);
  });

  it('falls back to venue default for party size exceeding rule range (e.g. 51+ covers)', () => {
    // 51 covers is outside [5, 50] range -> falls back to venue default (90)
    expect(resolveTurnMinutes(seedRules, { partySize: 51, daypart: 'dinner' })).toBe(DEFAULT_TURN_MINUTES);
    expect(resolveTurnMinutes(seedRules, { partySize: 100, daypart: 'dinner' }, 150)).toBe(150);
  });

  it('falls back to default for zero or negative party sizes without crashing', () => {
    expect(resolveTurnMinutes(seedRules, { partySize: 0, daypart: 'dinner' })).toBe(DEFAULT_TURN_MINUTES);
    expect(resolveTurnMinutes(seedRules, { partySize: -1, daypart: 'dinner' })).toBe(DEFAULT_TURN_MINUTES);
  });
});
