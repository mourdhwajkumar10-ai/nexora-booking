import type { AlertDto } from '@nexora/shared';
import type { Tx } from '../db/pool';
import { clock } from '../lib/clock';

export function toAlertDto(r: any): AlertDto {
  return {
    id: r.id,
    venueId: r.venue_id,
    kind: r.kind,
    severity: r.severity,
    title: r.title,
    body: r.body,
    data: r.data ?? {},
    acknowledgedAt: r.acknowledged_at ? new Date(r.acknowledged_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/** Create a console alert. `dedupeKey` makes it idempotent (returns null if it already exists). */
export async function createAlert(
  tx: Tx,
  a: {
    venueId: string;
    kind: AlertDto['kind'];
    severity: AlertDto['severity'];
    title: string;
    body?: string;
    data?: Record<string, unknown>;
    dedupeKey?: string;
  },
): Promise<AlertDto | null> {
  const row = await tx.one(
    `INSERT INTO alerts (venue_id, kind, severity, title, body, data, dedupe_key, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    [a.venueId, a.kind, a.severity, a.title, a.body ?? '', JSON.stringify(a.data ?? {}), a.dedupeKey ?? null, clock.now()],
  );
  if (!row) return null;
  const dto = toAlertDto(row);
  tx.emit({ type: 'alert.created', alert: dto });
  return dto;
}
