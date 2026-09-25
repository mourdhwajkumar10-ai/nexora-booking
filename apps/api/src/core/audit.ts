import type { Tx } from '../db/pool';
import { clock } from '../lib/clock';

export async function audit(
  tx: Tx,
  e: { venueId: string | null; actor: string; action: string; entity: string; entityId?: string | null; data?: unknown },
): Promise<void> {
  await tx.query('INSERT INTO audit_logs (venue_id, actor, action, entity, entity_id, data, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    e.venueId,
    e.actor,
    e.action,
    e.entity,
    e.entityId ?? null,
    JSON.stringify(e.data ?? {}),
    clock.now(),
  ]);
}
