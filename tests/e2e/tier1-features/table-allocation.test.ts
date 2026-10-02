import { describe, it, expect } from 'vitest';
import {
  sortBestFitTables,
  calculateShiftCapacity,
  floorTransition,
  type CandidateTable,
  type FloorStatus,
  type FloorAction,
} from '../helpers/oracle';

describe('Tier 1: Feature Coverage — Table Allocation, Shift Capacity & Floor FSM (F-BR06 / F-BR03 / F-BR09)', () => {
  describe('Best-fit table allocation heuristic (F-BR06)', () => {
    const floorTables: CandidateTable[] = [
      { id: 't-6', label: 'T6', minCapacity: 4, maxCapacity: 6, isCombination: false },
      { id: 't-4', label: 'T4', minCapacity: 2, maxCapacity: 4, isCombination: false },
      { id: 't-2', label: 'T2', minCapacity: 1, maxCapacity: 2, isCombination: false },
      { id: 't-combo-24', label: 'Combo-24', minCapacity: 4, maxCapacity: 6, isCombination: true, constituentTableIds: ['t-2', 't-4'] },
    ];

    it('allocates smallest non-negative seat differential (least wasted seats)', () => {
      // Party of 2 matches T2 (delta = 0) and T4 (delta = 2)
      const sorted = sortBestFitTables(floorTables, 2);
      expect(sorted[0].id).toBe('t-2');
      expect(sorted[1].id).toBe('t-4');
    });

    it('prefers single physical tables before multi-table combinations when capacities are equal', () => {
      // Party of 6 matches T6 (single, delta = 0) and Combo-24 (combination, delta = 0)
      const sorted = sortBestFitTables(floorTables, 6);
      expect(sorted[0].id).toBe('t-6');
      expect(sorted[0].isCombination).toBe(false);
      expect(sorted[1].id).toBe('t-combo-24');
      expect(sorted[1].isCombination).toBe(true);
    });

    it('filters out tables where party size is smaller than minCapacity or greater than maxCapacity', () => {
      // Party of 1 can only take T2 (min 1, max 2)
      const sorted1 = sortBestFitTables(floorTables, 1);
      expect(sorted1.map((t) => t.id)).toEqual(['t-2']);

      // Party of 8 cannot be seated at any table
      const sorted8 = sortBestFitTables(floorTables, 8);
      expect(sorted8.length).toBe(0);
    });
  });

  describe('Operational Shift Capacity Formula N_max (F-BR03)', () => {
    it('computes maximum sequential seatings per table accurately with +1 boundary correction', () => {
      // Plan Pack R-06 validation case:
      // T_open = 17:00 (1020m), T_last = 20:20 (1220m) [span = 200m]
      // T_turn = 90m, T_reset = 10m (step = 100m)
      // Bookable seatings: 17:00, 18:40, 20:20 -> exactly 3 seatings
      const nMax = calculateShiftCapacity(1020, 1220, 90, 10);
      expect(nMax).toBe(3);
    });

    it('returns 1 seating when shift span is shorter than turn + reset', () => {
      // Span = 60m, turn = 90m, reset = 10m -> 1 seating at open
      expect(calculateShiftCapacity(1020, 1080, 90, 10)).toBe(1);
    });

    it('returns 0 if last seating is before opening time', () => {
      expect(calculateShiftCapacity(1080, 1020, 90, 10)).toBe(0);
    });
  });

  describe('Floor Table Status State Machine (F-BR09)', () => {
    it('transitions through available -> occupied -> bussing -> available', () => {
      expect(floorTransition('available', 'seat')).toBe('occupied');
      expect(floorTransition('occupied', 'complete')).toBe('bussing');
      expect(floorTransition('bussing', 'clear')).toBe('available');
    });

    it('handles maintenance blocking and unblocking', () => {
      expect(floorTransition('available', 'block')).toBe('blocked');
      expect(floorTransition('blocked', 'unblock')).toBe('available');
      expect(floorTransition('bussing', 'block')).toBe('blocked');
    });

    it('rejects invalid floor transitions', () => {
      // Cannot seat an already occupied table
      expect(floorTransition('occupied', 'seat')).toBeNull();
      // Cannot clear an occupied table without completing
      expect(floorTransition('occupied', 'clear')).toBeNull();
      // Cannot complete an available table
      expect(floorTransition('available', 'complete')).toBeNull();
    });
  });
});
