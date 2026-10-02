import { describe, it, expect } from 'vitest';
import { NexoraPlatformSimulator } from '../helpers/client-simulator';

describe('Tier 3: Cross-Feature Combination — Multi-Table Combination + Dynamic Turn + Dwell Alerts', () => {
  it('coordinates multi-table combination, 120m dynamic turn, and synchronized dwell escalation', () => {
    const sim = new NexoraPlatformSimulator();
    const venueId = 'venue-us-001';
    const now = 1759431600000; // 19:00 UTC
    sim.setClock(now);

    // 1. Party of 6 books a table (exceeds single table max 4)
    const booking = sim.createReservation({
      venueId,
      guestId: 'guest-large-party-1',
      guestName: 'Eleanor Vance',
      guestPhone: '+15551234567',
      partySize: 6,
      serviceDate: '2026-10-02',
      startsAtMs: now,
    });

    // Dynamic turn time resolved to 120 minutes for party of 6
    expect(booking.turnMinutes).toBe(120);
    expect(booking.status).toBe('confirmed');

    // 2. Host seats the party at combination table Combo-23 (constituent tables T2 and T3)
    const comboTableId = 't-us-combo-23';
    sim.seatReservation(booking.id, comboTableId);

    // Verify both constituent tables and combo table are OCCUPIED
    const comboTable = sim.tables.get(comboTableId)!;
    const t2 = sim.tables.get('t-us-2')!;
    const t3 = sim.tables.get('t-us-3')!;

    expect(comboTable.status).toBe('occupied');
    expect(t2.status).toBe('occupied');
    expect(t3.status).toBe('occupied');
    expect(t2.seatedAtMs).toBe(now);
    expect(t3.seatedAtMs).toBe(now);

    // 3. Verify Dwell alerts evaluate proportionally across combination
    // At 60 minutes: Normal
    sim.advanceClock(60);
    expect(sim.getTableDwellState(comboTableId)).toEqual({ elapsedMinutes: 60, level: 'normal' });
    expect(sim.getTableDwellState('t-us-2')).toEqual({ elapsedMinutes: 60, level: 'normal' });

    // At 120 minutes (100% of 120m turn): Amber alert
    sim.advanceClock(60); // Total 120 min
    expect(sim.getTableDwellState(comboTableId)).toEqual({ elapsedMinutes: 120, level: 'amber' });
    expect(sim.getTableDwellState('t-us-2')).toEqual({ elapsedMinutes: 120, level: 'amber' });
    expect(sim.getTableDwellState('t-us-3')).toEqual({ elapsedMinutes: 120, level: 'amber' });

    // At 150 minutes (ceil(120 * 1.25) = 150m): Red alert
    sim.advanceClock(30); // Total 150 min
    expect(sim.getTableDwellState(comboTableId)).toEqual({ elapsedMinutes: 150, level: 'red' });
    expect(sim.getTableDwellState('t-us-2')).toEqual({ elapsedMinutes: 150, level: 'red' });
    expect(sim.getTableDwellState('t-us-3')).toEqual({ elapsedMinutes: 150, level: 'red' });

    // 4. Dining completes: Both tables move to BUSSING
    sim.completeDining(comboTableId);
    expect(comboTable.status).toBe('bussing');
    expect(t2.status).toBe('bussing');
    expect(t3.status).toBe('bussing');
    expect(booking.status).toBe('completed');

    // 5. Bussing cleared: Both tables return to AVAILABLE
    sim.clearTableBussing(comboTableId);
    expect(comboTable.status).toBe('available');
    expect(t2.status).toBe('available');
    expect(t3.status).toBe('available');
  });
});
