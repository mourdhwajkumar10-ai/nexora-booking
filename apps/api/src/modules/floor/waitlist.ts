import { z } from 'zod';
import {
  WaitlistJoinInput,
  WaitlistSeatInput,
  quoteWaitlist,
  tableFreeAt,
  type WaitParty,
  type WaitTable,
  type WaitlistEntryDto,
} from '@nexora/shared';
import { query, queryOne, withTx } from '../../db/pool';
import { getVenueById } from '../../core/venues';
import { upsertGuest } from '../../core/guests';
import { clock } from '../../lib/clock';
import { badRequest, notFound } from '../../lib/errors';
import { iso, parse } from '../../lib/http';
import { createWalkIn } from './walkins';

export async function computeWaitlistQuotes(venueId: string, resetBufferMins = 15): Promise<{
  entries: WaitlistEntryDto[];
  quotes: ReturnType<typeof quoteWaitlist>;
  waitTables: WaitTable[];
  parties: WaitParty[];
}> {
  const now = clock.now();
  const nowMs = now.getTime();

  // 1. Load active floor tables
  const tables = await query(
    `SELECT t.id, t.table_number, t.min_capacity, t.max_capacity, t.status,
            r.id AS res_id, r.start_at, r.seated_at, r.turn_minutes
     FROM dining_tables t
     LEFT JOIN reservations r ON r.table_id = t.id AND r.status = 'SEATED'
     WHERE t.venue_id = $1 AND t.archived_at IS NULL`,
    [venueId],
  );

  // 2. Load next upcoming reservation for each table
  const upcomingRes = await query(
    `SELECT table_id, min(start_at) as next_start
     FROM reservations
     WHERE venue_id = $1 AND status IN ('REQUESTED', 'CONFIRMED') AND start_at > $2
     GROUP BY table_id`,
    [venueId, now],
  );
  const nextStarts = new Map<string, number>();
  for (const u of upcomingRes) {
    if (u.table_id) nextStarts.set(u.table_id, new Date(u.next_start).getTime());
  }

  // 3. Build WaitTable list with freeAtMs (incorporating bussing buffer of 5m and predicted release)
  const waitTables: WaitTable[] = tables.map((t) => {
    let floorStatus: any = 'available';
    if (t.status === 'BLOCKED') floorStatus = 'blocked';
    else if (t.res_id) floorStatus = 'occupied';
    else if (t.status === 'BUSSING') floorStatus = 'bussing';

    let predictedReleaseMs: number | null = null;
    if (t.seated_at) {
      const seatedMs = new Date(t.seated_at).getTime();
      const turnMs = (t.turn_minutes || 90) * 60_000;
      predictedReleaseMs = seatedMs + turnMs;
    }

    const freeAtMs = tableFreeAt(floorStatus, nowMs, predictedReleaseMs);
    return {
      id: t.id,
      label: t.table_number,
      minCovers: t.min_capacity,
      maxCovers: t.max_capacity,
      freeAtMs,
      nextReservationStartMs: nextStarts.get(t.id) ?? null,
    };
  });

  // 4. Load all waiting parties in arrival order
  const waitEntries = await query(
    `SELECT w.*, g.first_name, g.last_name, g.phone_number
     FROM waitlist_entries w
     JOIN guests g ON g.id = w.guest_id
     WHERE w.venue_id = $1 AND w.status = 'WAITING'
     ORDER BY w.joined_at ASC`,
    [venueId],
  );

  const parties: WaitParty[] = waitEntries.map((e) => ({
    id: e.id,
    partySize: e.party_size,
    turnMinutes: e.party_size <= 2 ? 75 : e.party_size <= 4 ? 90 : 120,
  }));

  // 5. Run BR-11 greedy quoting algorithm with bussing buffer
  const quotes = quoteWaitlist(nowMs, waitTables, parties, resetBufferMins);
  const quoteMap = new Map(quotes.map((q) => [q.partyId, q]));

  const entries: WaitlistEntryDto[] = waitEntries.map((w) => {
    const q = quoteMap.get(w.id);
    return {
      id: w.id,
      venueId: w.venue_id,
      guestId: w.guest_id,
      guestName: `${w.first_name || ''} ${w.last_name || ''}`.trim() || 'Guest',
      guestPhone: w.phone_number,
      partySize: w.party_size,
      status: w.status,
      quotedMinutes: q?.quoteMinutes ?? w.quoted_minutes ?? 15,
      notes: w.notes,
      joinedAt: iso(w.joined_at)!,
      seatedAt: iso(w.seated_at),
    };
  });

  return { entries, quotes, waitTables, parties };
}

export async function joinWaitlist(
  venueId: string,
  input: z.infer<typeof WaitlistJoinInput>,
): Promise<WaitlistEntryDto> {
  const venue = await getVenueById(venueId);
  const now = clock.now();

  return withTx(async (tx) => {
    const { guest } = await upsertGuest(tx, {
      fullName: input.guestName,
      phone: input.phone,
    });

    const quoteData = await computeWaitlistQuotes(venueId, venue.reset_buffer_mins ?? 15);
    const estimatedTurn = input.partySize <= 2 ? 75 : input.partySize <= 4 ? 90 : 120;
    const allParties: WaitParty[] = [
      ...quoteData.parties,
      { id: 'joining-party', partySize: input.partySize, turnMinutes: estimatedTurn },
    ];

    const quotes = quoteWaitlist(
      now.getTime(),
      quoteData.waitTables,
      allParties,
      venue.reset_buffer_mins ?? 15,
    );

    const myQuote = quotes[quotes.length - 1];
    const quotedMins = myQuote?.quoteMinutes ?? 15;

    const row = await tx.one(
      `INSERT INTO waitlist_entries (venue_id, guest_id, party_size, status, quoted_minutes, notes, joined_at)
       VALUES ($1, $2, $3, 'WAITING', $4, $5, $6) RETURNING *`,
      [venueId, guest.id, input.partySize, quotedMins, input.notes ?? null, now],
    );

    return {
      id: row!.id,
      venueId: row!.venue_id,
      guestId: row!.guest_id,
      guestName: input.guestName,
      guestPhone: input.phone,
      partySize: row!.party_size,
      status: 'WAITING',
      quotedMinutes: quotedMins,
      notes: row!.notes,
      joinedAt: iso(row!.joined_at)!,
    };
  });
}

export async function seatWaitlistEntry(
  venueId: string,
  entryId: string,
  input: z.infer<typeof WaitlistSeatInput>,
  actor: string,
): Promise<any> {
  const now = clock.now();
  return withTx(async (tx) => {
    const entry = await tx.one('SELECT * FROM waitlist_entries WHERE id = $1 AND venue_id = $2 FOR UPDATE', [
      entryId,
      venueId,
    ]);
    if (!entry) throw notFound('Waitlist entry');
    if (entry.status !== 'WAITING') {
      throw badRequest('NOT_WAITING', `Entry is ${entry.status} and cannot be seated`);
    }

    const guest = await tx.one('SELECT * FROM guests WHERE id = $1', [entry.guest_id]);
    if (!guest) throw notFound('Guest');

    // Create seated walk-in reservation inside same transaction
    const res = await createWalkIn(
      venueId,
      {
        partySize: entry.party_size,
        tableId: input.tableId,
        guestName: `${guest.first_name ?? ''} ${guest.last_name ?? ''}`.trim() || undefined,
        phone: guest.phone_number ?? undefined,
        override: true,
      },
      actor,
      tx,
    );

    await tx.query("UPDATE waitlist_entries SET status = 'SEATED', seated_at = $2 WHERE id = $1", [entryId, now]);

    return res;
  });
}
