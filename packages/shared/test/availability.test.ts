import { describe, expect, it } from 'vitest';
import {
  allocateBestFit,
  computeAvailability,
  nearestAlternatives,
  occupancyFor,
  slotMinutes,
  type AvailabilityQuery,
  type TableInput,
} from '../src/availability.ts';
import { resolveTurnMinutes, validateTurnRules, type TurnRule } from '../src/turn.ts';

const table = (id: string, min: number, max: number, extra: Partial<TableInput> = {}): TableInput => ({
  id,
  label: id.toUpperCase(),
  minCovers: min,
  maxCovers: max,
  diningAreaId: 'main',
  areaSortOrder: 0,
  active: true,
  onlineBookable: true,
  ...extra,
});

const TABLES: TableInput[] = [
  table('t1', 1, 2),
  table('t2', 1, 2),
  table('t3', 2, 4),
  table('t4', 3, 4, { onlineBookable: false }),
  table('t5', 2, 4),
  table('t6', 2, 4),
  table('b1', 1, 2, { diningAreaId: 'bar', areaSortOrder: 1 }),
];

const RULES: TurnRule[] = [
  { id: 'r1', partyMin: 1, partyMax: 2, daypart: null, diningAreaId: null, minutes: 75 },
  { id: 'r2', partyMin: 3, partyMax: 4, daypart: null, diningAreaId: null, minutes: 90 },
  { id: 'r3', partyMin: 5, partyMax: 50, daypart: null, diningAreaId: null, minutes: 120 },
  { id: 'rb', partyMin: 1, partyMax: 2, daypart: null, diningAreaId: 'bar', minutes: 45 },
];

const base = (over: Partial<AvailabilityQuery> = {}): AvailabilityQuery => ({
  serviceDate: '2026-06-15',
  timeZone: 'America/New_York',
  period: { id: 'dinner', daypart: 'dinner', openMinute: 1020, lastSeatingMinute: 1260, closeMinute: 1380 },
  slotIntervalMinutes: 15,
  partySize: 2,
  channel: 'public',
  nowMs: Date.parse('2026-06-15T12:00:00Z'),
  minLeadMinutes: 30,
  resetMinutes: 10,
  turnRules: RULES,
  defaultTurnMinutes: 90,
  diningAreaId: null,
  tables: TABLES,
  combinations: [{ id: 'c56', name: 'T5+T6', minCovers: 5, maxCovers: 8, tableIds: ['t5', 't6'], active: true }],
  occupancies: [],
  maxCoversPerSlot: null,
  pacingBookings: [],
  closed: false,
  ...over,
});

const at = (iso: string) => Date.parse(iso);

describe('BR-05 turn rules', () => {
  const rules: TurnRule[] = [
    ...RULES,
    { id: 'r4', partyMin: 1, partyMax: 4, daypart: 'brunch', diningAreaId: null, minutes: 60 },
    { id: 'r6', partyMin: 1, partyMax: 2, daypart: 'dinner', diningAreaId: 'bar', minutes: 50 },
  ];
  it('picks the most specific rule', () => {
    expect(resolveTurnMinutes(rules, { partySize: 2, daypart: 'dinner', diningAreaId: 'main' })).toBe(75);
    expect(resolveTurnMinutes(rules, { partySize: 2, daypart: 'dinner', diningAreaId: 'bar' })).toBe(50);
    expect(resolveTurnMinutes(rules, { partySize: 2, daypart: 'lunch', diningAreaId: 'bar' })).toBe(45);
    expect(resolveTurnMinutes(rules, { partySize: 3, daypart: 'brunch', diningAreaId: 'main' })).toBe(60);
    expect(resolveTurnMinutes(rules, { partySize: 6, daypart: 'dinner' })).toBe(120);
  });
  it('falls back when nothing matches and prefers narrower ranges on ties', () => {
    expect(resolveTurnMinutes(rules, { partySize: 60, daypart: 'dinner' })).toBe(90);
    const tie: TurnRule[] = [
      { id: 'a', partyMin: 1, partyMax: 4, daypart: null, diningAreaId: null, minutes: 80 },
      { id: 'b', partyMin: 3, partyMax: 4, daypart: null, diningAreaId: null, minutes: 95 },
    ];
    expect(resolveTurnMinutes(tie, { partySize: 3, daypart: 'dinner' })).toBe(95);
  });
  it('validates ranges, minutes and overlaps', () => {
    expect(validateTurnRules(RULES)).toEqual([]);
    const bad: TurnRule[] = [
      { id: 'x', partyMin: 1, partyMax: 2, daypart: null, diningAreaId: null, minutes: 75 },
      { id: 'y', partyMin: 2, partyMax: 4, daypart: null, diningAreaId: null, minutes: 17 },
    ];
    expect(validateTurnRules(bad)).toEqual([
      { code: 'INVALID_MINUTES', ruleIds: ['y'] },
      { code: 'OVERLAP', ruleIds: ['x', 'y'] },
    ]);
  });
});

describe('BR-03 slot grid', () => {
  it('starts at the first interval boundary and includes the last seating', () => {
    expect(slotMinutes({ id: 'p', daypart: 'dinner', openMinute: 1020, lastSeatingMinute: 1260, closeMinute: 1380 }, 15)).toHaveLength(17);
    expect(slotMinutes({ id: 'p', daypart: 'dinner', openMinute: 1010, lastSeatingMinute: 1050, closeMinute: 1380 }, 15)).toEqual([1020, 1035, 1050]);
  });
});

describe('BR-06 availability and best fit', () => {
  it('assigns the tightest main-room table first', () => {
    const slots = computeAvailability(base());
    expect(slots).toHaveLength(17);
    expect(slots[0]).toEqual({
      minuteOfDay: 1020,
      startsAt: '2026-06-15T21:00:00.000Z',
      available: true,
      reason: null,
      turnMinutes: 75,
      unit: { kind: 'table', id: 't1', label: 'T1', tableIds: ['t1'], maxCovers: 2, turnMinutes: 75 },
    });
  });
  it('falls back to the bar (with the bar turn time) when two-tops are busy', () => {
    const occ = [
      { tableId: 't1', startMs: at('2026-06-15T21:00:00Z'), endMs: at('2026-06-15T22:25:00Z') },
      { tableId: 't2', startMs: at('2026-06-15T21:00:00Z'), endMs: at('2026-06-15T22:25:00Z') },
    ];
    const s = computeAvailability(base({ occupancies: occ }))[0]!;
    expect(s.unit?.id).toBe('b1');
    expect(s.turnMinutes).toBe(45);
  });
  it('hides non-online tables from public channels but not staff', () => {
    const occT3 = [{ tableId: 't3', startMs: at('2026-06-15T21:00:00Z'), endMs: at('2026-06-15T22:40:00Z') }];
    expect(computeAvailability(base({ partySize: 4 }))[0]!.unit?.id).toBe('t3');
    expect(computeAvailability(base({ partySize: 4, occupancies: occT3 }))[0]!.unit?.id).toBe('t5');
    expect(computeAvailability(base({ partySize: 4, occupancies: occT3, channel: 'staff' }))[0]!.unit?.id).toBe('t4');
  });
  it('uses combinations only when no single table fits', () => {
    const s = computeAvailability(base({ partySize: 6 }))[0]!;
    expect(s.unit).toEqual({ kind: 'combination', id: 'c56', label: 'T5+T6', tableIds: ['t5', 't6'], maxCovers: 8, turnMinutes: 120 });
    const busy = [{ tableId: 't6', startMs: at('2026-06-15T20:00:00Z'), endMs: at('2026-06-15T21:30:00Z') }];
    expect(computeAvailability(base({ partySize: 6, occupancies: busy }))[0]!.reason).toBe('no_table');
  });
  it('applies minimum lead time', () => {
    const slots = computeAvailability(base({ nowMs: at('2026-06-15T21:10:00Z') }));
    expect(slots.slice(0, 4).map((s) => s.reason)).toEqual(['lead_time', 'lead_time', 'lead_time', null]);
  });
  it('applies cover pacing per slot', () => {
    const slots = computeAvailability(
      base({
        partySize: 3,
        maxCoversPerSlot: 10,
        pacingBookings: [
          { startsAtMs: at('2026-06-15T21:00:00Z'), partySize: 4 },
          { startsAtMs: at('2026-06-15T21:00:00Z'), partySize: 4 },
        ],
      }),
    );
    expect(slots[0]!.reason).toBe('pacing');
    expect(slots[1]!.available).toBe(true);
  });
  it('marks every slot closed on closure days', () => {
    expect(computeAvailability(base({ closed: true })).every((s) => s.reason === 'closed')).toBe(true);
  });
  it('treats occupancy ranges as half-open [start, end)', () => {
    const q = base({ tables: [table('t1', 1, 2)], occupancies: [{ tableId: 't1', startMs: at('2026-06-15T21:00:00Z'), endMs: at('2026-06-15T22:30:00Z') }] });
    const slots = computeAvailability(q);
    expect(slots.find((s) => s.minuteOfDay === 1095)!.reason).toBe('no_table');
    expect(slots.find((s) => s.minuteOfDay === 1110)!.unit?.id).toBe('t1');
    const alts = nearestAlternatives(slots, at('2026-06-15T22:00:00Z'));
    expect(alts.map((s) => s.minuteOfDay)).toEqual([1110, 1125, 1140]);
  });
  it('computes DST-day instants correctly', () => {
    expect(computeAvailability(base({ serviceDate: '2026-03-08', nowMs: at('2026-03-08T12:00:00Z') }))[0]!.startsAt).toBe('2026-03-08T21:00:00.000Z');
  });
  it('filters by dining area and supports exclusions', () => {
    expect(computeAvailability(base({ diningAreaId: 'bar' }))[0]!.unit?.id).toBe('b1');
    expect(allocateBestFit(base(), at('2026-06-15T21:00:00Z'), ['t1'])?.id).toBe('t2');
  });
  it('builds occupancy ranges that include the reset buffer', () => {
    expect(occupancyFor(0, 90, 10)).toEqual({ startMs: 0, endMs: 100 * 60_000 });
  });
});
