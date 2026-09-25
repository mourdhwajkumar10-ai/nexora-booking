import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { StaffRole, StaffUser } from '@nexora/shared';
import { forbidden, unauthorized } from './errors';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

declare module 'fastify' {
  interface FastifyRequest {
    staff?: StaffUser;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: StaffUser;
    user: StaffUser;
  }
}

/** preHandler: require a logged-in staff member (JWT in httpOnly cookie). */
export async function requireStaff(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  try {
    const user = await req.jwtVerify<StaffUser>();
    req.staff = user;
  } catch {
    throw unauthorized();
  }
}

export function requireRole(...roles: StaffRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireStaff(req, reply);
    if (!req.staff || !roles.includes(req.staff.role)) throw forbidden(`Requires role: ${roles.join(' or ')}`);
  };
}

/** Throw 403 unless the staff member may operate on `venueId` (org-wide staff have venueId = null). */
export function assertVenueAccess(staff: StaffUser | undefined, venueId: string): void {
  if (!staff) throw unauthorized();
  if (staff.venueId && staff.venueId !== venueId) throw forbidden('You do not have access to this venue');
}

export const actorOf = (req: FastifyRequest): string => (req.staff ? `staff:${req.staff.email}` : 'system');
