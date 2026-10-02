/**
 * BR-18 "Claim this visit" matching and fraud limits.
 */
import { diffDays, type IsoDate } from './time';

export interface ClaimInput {
  businessDate: IsoDate;
  totalCents: number;
  /** last 4 card digits printed on the receipt, if the guest paid by card */
  last4: string | null;
  checkNumber: string | null;
}

export interface ClaimCandidateCheck {
  id: string;
  businessDate: IsoDate;
  status: 'open' | 'closed' | 'voided';
  totalCents: number;
  totalBeforeTipCents: number;
  checkNumber: string | null;
  cardLast4s: ReadonlyArray<string>;
  hasCardPayment: boolean;
  /** network account already credited with this check, if any */
  creditedAccountId: string | null;
}

export interface ClaimContext {
  accountId: string;
  todayBusinessDate: IsoDate;
  claimsTodayByAccount: number;
}

export type ClaimResult =
  | { status: 'matched'; checkId: string }
  | { status: 'manual_review'; reason: 'ambiguous' | 'cash_over_limit'; checkIds: string[] }
  | {
      status: 'rejected';
      reason:
        | 'rate_limited'
        | 'future_date'
        | 'too_old'
        | 'last4_required'
        | 'no_match'
        | 'already_claimed'
        | 'already_credited'
        | 'check_number_required';
    };

export const CLAIM_LIMITS = { perDay: 3, maxAgeDays: 90, noLast4MaxAgeDays: 14, cashAutoApproveMaxCents: 15_000 } as const;

export function matchClaim(input: ClaimInput, candidates: ReadonlyArray<ClaimCandidateCheck>, ctx: ClaimContext): ClaimResult {
  if (ctx.claimsTodayByAccount >= CLAIM_LIMITS.perDay) return { status: 'rejected', reason: 'rate_limited' };
  const age = diffDays(ctx.todayBusinessDate, input.businessDate);
  if (age < 0) return { status: 'rejected', reason: 'future_date' };
  if (age > CLAIM_LIMITS.maxAgeDays) return { status: 'rejected', reason: 'too_old' };
  if (age > CLAIM_LIMITS.noLast4MaxAgeDays && !input.last4) return { status: 'rejected', reason: 'last4_required' };
  const checkNumber = input.checkNumber?.trim() || null;
  const matches = candidates.filter(
    (c) =>
      c.businessDate === input.businessDate &&
      c.status === 'closed' &&
      (c.totalCents === input.totalCents || c.totalBeforeTipCents === input.totalCents) &&
      (checkNumber === null || (c.checkNumber ?? '').trim() === checkNumber) &&
      (input.last4 === null || c.cardLast4s.includes(input.last4)),
  );
  if (matches.length === 0) return { status: 'rejected', reason: 'no_match' };
  if (matches.length > 1) return { status: 'manual_review', reason: 'ambiguous', checkIds: matches.map((m) => m.id) };
  const c = matches[0]!;
  if (c.creditedAccountId !== null) {
    return { status: 'rejected', reason: c.creditedAccountId === ctx.accountId ? 'already_credited' : 'already_claimed' };
  }
  if (!c.hasCardPayment) {
    if (checkNumber === null) return { status: 'rejected', reason: 'check_number_required' };
    if (c.totalCents > CLAIM_LIMITS.cashAutoApproveMaxCents) return { status: 'manual_review', reason: 'cash_over_limit', checkIds: [c.id] };
  }
  return { status: 'matched', checkId: c.id };
}
