import { describe, it, expect } from 'vitest';
import { timerState, type AlertLevel } from '../helpers/oracle';

describe('Tier 1: Feature Coverage — Dynamic Dwell Alert Timers (F-BR10 / Acceptance Criterion 2)', () => {
  const seatedAt = 1759431600000; // Base epoch ms

  it('evaluates dwell alerts correctly for standard 90-minute turn', () => {
    const turnMinutes = 90;
    // Red threshold = ceil(90 * 1.25) = ceil(112.5) = 113 minutes

    // 0 to 89 minutes -> normal
    expect(timerState(seatedAt, turnMinutes, seatedAt + 0)).toEqual({ elapsedMinutes: 0, level: 'normal' });
    expect(timerState(seatedAt, turnMinutes, seatedAt + 45 * 60_000)).toEqual({ elapsedMinutes: 45, level: 'normal' });
    expect(timerState(seatedAt, turnMinutes, seatedAt + 89 * 60_000)).toEqual({ elapsedMinutes: 89, level: 'normal' });

    // 90 minutes (100% turn duration) -> amber
    expect(timerState(seatedAt, turnMinutes, seatedAt + 90 * 60_000)).toEqual({ elapsedMinutes: 90, level: 'amber' });
    expect(timerState(seatedAt, turnMinutes, seatedAt + 100 * 60_000)).toEqual({ elapsedMinutes: 100, level: 'amber' });
    expect(timerState(seatedAt, turnMinutes, seatedAt + 112 * 60_000)).toEqual({ elapsedMinutes: 112, level: 'amber' });

    // 113 minutes (ceil(125%) = 113) -> red
    expect(timerState(seatedAt, turnMinutes, seatedAt + 113 * 60_000)).toEqual({ elapsedMinutes: 113, level: 'red' });
    expect(timerState(seatedAt, turnMinutes, seatedAt + 130 * 60_000)).toEqual({ elapsedMinutes: 130, level: 'red' });
  });

  it('evaluates dwell alerts correctly for 75-minute turn (1-2 covers)', () => {
    const turnMinutes = 75;
    // Red threshold = ceil(75 * 1.25) = ceil(93.75) = 94 minutes

    // Under 75 minutes -> normal
    expect(timerState(seatedAt, turnMinutes, seatedAt + 74 * 60_000)).toEqual({ elapsedMinutes: 74, level: 'normal' });

    // Exactly 75 minutes (100%) -> amber
    expect(timerState(seatedAt, turnMinutes, seatedAt + 75 * 60_000)).toEqual({ elapsedMinutes: 75, level: 'amber' });
    expect(timerState(seatedAt, turnMinutes, seatedAt + 93 * 60_000)).toEqual({ elapsedMinutes: 93, level: 'amber' });

    // 94 minutes (ceil(125%)) -> red
    expect(timerState(seatedAt, turnMinutes, seatedAt + 94 * 60_000)).toEqual({ elapsedMinutes: 94, level: 'red' });
  });

  it('evaluates dwell alerts correctly for 120-minute turn (5+ covers)', () => {
    const turnMinutes = 120;
    // Red threshold = ceil(120 * 1.25) = 150 minutes

    // Under 120 minutes -> normal
    expect(timerState(seatedAt, turnMinutes, seatedAt + 119 * 60_000)).toEqual({ elapsedMinutes: 119, level: 'normal' });

    // Exactly 120 minutes (100%) -> amber
    expect(timerState(seatedAt, turnMinutes, seatedAt + 120 * 60_000)).toEqual({ elapsedMinutes: 120, level: 'amber' });
    expect(timerState(seatedAt, turnMinutes, seatedAt + 149 * 60_000)).toEqual({ elapsedMinutes: 149, level: 'amber' });

    // 150 minutes (125%) -> red
    expect(timerState(seatedAt, turnMinutes, seatedAt + 150 * 60_000)).toEqual({ elapsedMinutes: 150, level: 'red' });
  });

  it('safely handles non-positive or future seated times by flooring to 0 elapsed minutes', () => {
    const turnMinutes = 90;
    // nowMs is before seatedAt
    expect(timerState(seatedAt, turnMinutes, seatedAt - 5000)).toEqual({ elapsedMinutes: 0, level: 'normal' });
  });
});
