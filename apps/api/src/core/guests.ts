import type { Tx } from '../db/pool';

export interface GuestRow {
  id: string;
  first_name: string;
  last_name: string;
  phone_number: string;
  email: string | null;
  created_at: Date;
}

export function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
}

/**
 * Identity resolution by phone (primary) then email. Creates guest + profile + BASE loyalty
 * account when new. Never overwrites existing names/emails with blanks; ignores an email that
 * already belongs to another guest.
 */
export async function upsertGuest(
  tx: Tx,
  input: { fullName?: string; firstName?: string; lastName?: string; phone: string; email?: string | null },
): Promise<{ guest: GuestRow; isNew: boolean }> {
  const names = input.fullName ? splitName(input.fullName) : { firstName: input.firstName ?? '', lastName: input.lastName ?? '' };
  const email = input.email?.trim().toLowerCase() || null;

  let guest = await tx.one<GuestRow>('SELECT * FROM guests WHERE phone_number = $1 FOR UPDATE', [input.phone]);
  if (!guest && email) guest = await tx.one<GuestRow>('SELECT * FROM guests WHERE email = $1 FOR UPDATE', [email]);

  if (guest) {
    const emailFree = email && !guest.email ? !(await tx.one('SELECT 1 FROM guests WHERE email = $1', [email])) : false;
    const updated = await tx.one<GuestRow>(
      `UPDATE guests SET
         first_name = CASE WHEN $2 <> '' THEN $2 ELSE first_name END,
         last_name  = CASE WHEN $3 <> '' THEN $3 ELSE last_name END,
         email      = CASE WHEN $4::boolean THEN $5 ELSE email END
       WHERE id = $1 RETURNING *`,
      [guest.id, names.firstName, names.lastName, emailFree, email],
    );
    return { guest: updated!, isNew: false };
  }

  const emailTaken = email ? !!(await tx.one('SELECT 1 FROM guests WHERE email = $1', [email])) : false;
  const created = await tx.one<GuestRow>(
    `INSERT INTO guests (first_name, last_name, phone_number, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
     RETURNING *`,
    [names.firstName || 'Guest', names.lastName, input.phone, emailTaken ? null : email],
  );
  await tx.query('INSERT INTO guest_profiles (guest_id) VALUES ($1) ON CONFLICT DO NOTHING', [created!.id]);
  await tx.query('INSERT INTO loyalty_accounts (guest_id) VALUES ($1) ON CONFLICT DO NOTHING', [created!.id]);
  return { guest: created!, isNew: true };
}

export const guestDisplayName = (g: { first_name: string; last_name: string }) => `${g.first_name} ${g.last_name}`.trim();

export function maskPhone(phone: string): string {
  return `${'•'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;
}

/** Anonymous walk-ins get a synthetic `walkin:<id>` phone; never message or list them as real contacts. */
export const isSyntheticPhone = (phone: string) => phone.startsWith('walkin:');
