import { describe, it, expect } from 'vitest';
import { timerState } from '../helpers/oracle';

describe('Tier 2: Boundary & Corner Cases — Exact Second Dwell Escalation Thresholds', () => {
  const seatedAt = 1759431600000;

  describe('90-minute turn duration (Red threshold = 113 minutes)', () => {
    const turnMinutes = 90;

    it('remains NORMAL at 89m 59s (5,399,000 ms elapsed)', () => {
      const state = timerState(seatedAt, turnMinutes, seatedAt + (89 * 60 + 59) * 1000);
      expect(state.elapsedMinutes).toBe(89);
      expect(state.level).toBe('normal');
    });

    it('flips to AMBER at exactly 90m 00s (5,400,000 ms elapsed)', () => {
      const state = timerState(seatedAt, turnMinutes, seatedAt + 90 * 60 * 1000);
      expect(state.elapsedMinutes).toBe(90);
      expect(state.level).toBe('amber');
    });

    it('remains AMBER at 90m 01s (5,401,000 ms elapsed)', () => {
      const state = timerState(seatedAt, turnMinutes, seatedAt + (90 * 60 + 1) * 1000);
      expect(state.elapsedMinutes).toBe(90);
      expect(state.level).toBe('amber');
    });

    it('remains AMBER at 112m 59s (6,779,000 ms elapsed)', () => {
      const state = timerState(seatedAt, turnMinutes, seatedAt + (112 * 60 + 59) * 1000);
      expect(state.elapsedMinutes).toBe(112);
      expect(state.level).toBe('amber');
    });

    it('flips to RED at exactly 113m 00s (6,780,000 ms elapsed)', () => {
      const state = timerState(seatedAt, turnMinutes, seatedAt + 113 * 60 * 1000);
      expect(state.elapsedMinutes).toBe(113);
      expect(state.level).toBe('red');
    });

    it('remains RED at 113m 01s (6,781,000 ms elapsed)', () => {
      const state = timerState(seatedAt, turnMinutes, seatedAt + (113 * 60 + 1) * 1000);
      expect(state.elapsedMinutes).toBe(113);
      expect(state.level).toBe('red');
    });
  });

  describe('75-minute turn duration (Red threshold = 94 minutes)', () => {
    const turnMinutes = 75;

    it('transitions 74m 59s (normal) -> 75m 00s (amber)', () => {
      const normal = timerState(seatedAt, turnMinutes, seatedAt + (74 * 60 + 59) * 1000);
      expect(normal.elapsedMinutes).toBe(74);
      expect(normal.level).toBe('normal');

      const amber = timerState(seatedAt, turnMinutes, seatedAt + 75 * 60 * 1000);
      expect(amber.elapsedMinutes).toBe(75);
      expect(amber.level).toBe('amber');
    });

    it('transitions 93m 59s (amber) -> 94m 00s (red)', () => {
      const amber = timerState(seatedAt, turnMinutes, seatedAt + (93 * 60 + 59) * 1000);
      expect(amber.elapsedMinutes).toBe(93);
      expect(amber.level).toBe('amber');

      const red = timerState(seatedAt, turnMinutes, seatedAt + 94 * 60 * 1000);
      expect(red.elapsedMinutes).toBe(94);
      expect(red.level).toBe('red');
    });
  });

  describe('120-minute turn duration (Red threshold = 150 minutes)', () => {
    const turnMinutes = 120;

    it('transitions 119m 59s (normal) -> 120m 00s (amber)', () => {
      const normal = timerState(seatedAt, turnMinutes, seatedAt + (119 * 60 + 59) * 1000);
      expect(normal.elapsedMinutes).toBe(119);
      expect(normal.level).toBe('normal');

      const amber = timerState(seatedAt, turnMinutes, seatedAt + 120 * 60 * 1000);
      expect(amber.elapsedMinutes).toBe(120);
      expect(amber.level).toBe('amber');
    });

    it('transitions 149m 59s (amber) -> 150m 00s (red)', () => {
      const amber = timerState(seatedAt, turnMinutes, seatedAt + (149 * 60 + 59) * 1000);
      expect(amber.elapsedMinutes).toBe(149);
      expect(amber.level).toBe('amber');

      const red = timerState(seatedAt, turnMinutes, seatedAt + 150 * 60 * 1000);
      expect(red.elapsedMinutes).toBe(150);
      expect(red.level).toBe('red');
    });
  });
});
