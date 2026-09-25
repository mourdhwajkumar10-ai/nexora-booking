'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { CreateBookingInput, SEATING_PREFERENCES, type PublicReservation, type SlotConflictDetails } from '@nexora/shared';
import { api, ApiRequestError } from '@/lib/api';
import { formatTime12 } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { controlText, FormField, Notice } from './form-field';

export interface BookingFormValues {
  fullName: string;
  phone: string;
  email: string;
  dietaryRequests: string;
  seatingPreference: string;
  notes: string;
}
export const EMPTY_BOOKING_FORM: BookingFormValues = { fullName: '', phone: '', email: '', dietaryRequests: '', seatingPreference: '', notes: '' };

type FieldKey = keyof BookingFormValues;
const FIELD_ORDER: FieldKey[] = ['fullName', 'phone', 'email', 'dietaryRequests', 'seatingPreference', 'notes'];

const FRIENDLY: Partial<Record<FieldKey, string>> = {
  fullName: 'Enter your full name (at least 2 characters).',
  phone: 'Enter a valid mobile number, e.g. +91 98765 43210.',
  email: 'Enter a valid email address, or leave it blank.',
  dietaryRequests: 'Keep this under 500 characters.',
  notes: 'Keep this under 500 characters.',
};

const SEATING_LABEL: Record<(typeof SEATING_PREFERENCES)[number], string> = {
  ANY: 'No preference',
  BOOTH: 'Booth',
  WINDOW: 'By the window',
  QUIET: 'Quiet corner',
  PATIO: 'Patio / outdoors',
};

export function BookingForm({
  slug,
  date,
  dateLabel,
  time,
  partySize,
  values,
  onValuesChange,
  onChangeTime,
  onConflict,
  onCancel,
}: {
  slug: string;
  date: string;
  dateLabel: string;
  time: string;
  partySize: number;
  values: BookingFormValues;
  onValuesChange: (v: BookingFormValues) => void;
  onChangeTime: (t: string) => void;
  onConflict: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ time: string; alternatives: string[] } | null>(null);

  const validate = (v: BookingFormValues) => {
    const parsed = CreateBookingInput.safeParse({
      date,
      time,
      partySize,
      fullName: v.fullName,
      phone: v.phone,
      email: v.email,
      dietaryRequests: v.dietaryRequests.trim() || undefined,
      seatingPreference: v.seatingPreference || undefined,
      notes: v.notes.trim() || undefined,
    });
    if (parsed.success) return { data: parsed.data, errors: {} };
    const next: Partial<Record<FieldKey, string>> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as FieldKey;
      if (FIELD_ORDER.includes(key) && !next[key]) next[key] = FRIENDLY[key] ?? issue.message;
    }
    return { data: null, errors: next };
  };

  const set = (key: FieldKey) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const v = { ...values, [key]: e.target.value };
    onValuesChange(v);
    // After the first submit attempt, re-validate live so errors clear as they're fixed.
    if (submitted) setErrors(validate(v).errors);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setApiError(null);
    const { data, errors: errs } = validate(values);
    setErrors(errs);
    if (!data) {
      const first = FIELD_ORDER.find((k) => errs[k]);
      if (first) formRef.current?.querySelector<HTMLElement>(`#bk-${first}`)?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const res = await api<PublicReservation>(`/venues/${encodeURIComponent(slug)}/reservations`, { method: 'POST', json: data });
      router.push(`/booking/${res.token}`);
      // Keep the spinner up while the tracker loads.
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiRequestError && err.code === 'SLOT_UNAVAILABLE') {
        const alternatives = ((err.details as SlotConflictDetails | undefined)?.alternatives ?? []).filter((t) => t !== time);
        setConflict({ time, alternatives });
        onConflict();
        return;
      }
      if (err instanceof ApiRequestError && err.code === 'VENUE_BLACKOUT') onConflict();
      setApiError(err instanceof ApiRequestError ? err.message : 'We couldn’t reach the restaurant. Check your connection and try again.');
    }
  };

  const pickAlternative = (t: string) => {
    setConflict(null);
    setApiError(null);
    onChangeTime(t);
  };

  const showConflict = conflict && conflict.time === time;

  return (
    <form ref={formRef} noValidate onSubmit={onSubmit} className="animate-fade-in border-t border-border bg-background-2 px-5 py-5" aria-labelledby="booking-form-heading">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h3 id="booking-form-heading" className="text-[15px] font-semibold tracking-tight">
            Your details
          </h3>
          <p className="mt-0.5 text-[13px] text-gray-900 tabular-nums">
            {dateLabel} · <span className="font-medium text-gray-1000">{formatTime12(time)}</span> · {partySize} {partySize === 1 ? 'guest' : 'guests'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Change
        </Button>
      </div>

      <div aria-live="assertive" className="empty:hidden">
        {showConflict ? (
          <Notice tone="amber" className="mb-5" title={`${formatTime12(conflict.time)} was just taken`}>
            {conflict.alternatives.length > 0 ? (
              <>
                <p>These times are still open for {partySize}:</p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {conflict.alternatives.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => pickAlternative(t)}
                      className="h-8 touch-manipulation rounded-md border border-amber/30 bg-background px-3 text-[13px] font-medium text-gray-1000 tabular-nums transition-colors duration-150 hover:border-gray-1000"
                    >
                      {formatTime12(t)}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p>No nearby times are open. Try a different date or party size.</p>
            )}
          </Notice>
        ) : null}
        {apiError ? (
          <Notice tone="red" className="mb-5" title="Couldn't place your request">
            {apiError}
          </Notice>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField id="bk-fullName" label="Full name" error={errors.fullName} className="sm:col-span-2">
          {(a) => <Input {...a} name="name" autoComplete="name" value={values.fullName} onChange={set('fullName')} placeholder="Aarav Sharma" className={controlText} />}
        </FormField>
        <FormField id="bk-phone" label="Mobile number" error={errors.phone} hint="Include +91. We'll text you when the restaurant confirms.">
          {(a) => (
            <Input
              {...a}
              name="tel"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={values.phone}
              onChange={set('phone')}
              placeholder="+91 98765 43210"
              className={cn(controlText, 'tabular-nums')}
            />
          )}
        </FormField>
        <FormField id="bk-email" label="Email" optional error={errors.email}>
          {(a) => (
            <Input
              {...a}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              spellCheck={false}
              value={values.email}
              onChange={set('email')}
              placeholder="you@example.com"
              className={controlText}
            />
          )}
        </FormField>
        <FormField id="bk-seatingPreference" label="Seating preference" optional className="sm:col-span-2">
          {(a) => (
            <Select {...a} value={values.seatingPreference} onChange={set('seatingPreference')} className={controlText}>
              <option value="">No preference</option>
              {SEATING_PREFERENCES.filter((s) => s !== 'ANY').map((s) => (
                <option key={s} value={s}>
                  {SEATING_LABEL[s]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField id="bk-dietaryRequests" label="Dietary requests" optional error={errors.dietaryRequests} className="sm:col-span-2">
          {(a) => (
            <Input
              {...a}
              value={values.dietaryRequests}
              onChange={set('dietaryRequests')}
              placeholder="Vegetarian, nut allergy, Jain…"
              maxLength={500}
              className={controlText}
            />
          )}
        </FormField>
        <FormField id="bk-notes" label="Notes for the restaurant" optional error={errors.notes} className="sm:col-span-2">
          {(a) => (
            <Textarea {...a} rows={2} value={values.notes} onChange={set('notes')} placeholder="Celebrating a birthday…" maxLength={500} className={controlText} />
          )}
        </FormField>
      </div>

      <Button type="submit" size="lg" loading={submitting} className="mt-6 w-full">
        {submitting ? 'Sending request…' : 'Request booking'}
        {!submitting ? <ArrowRight size={16} aria-hidden /> : null}
      </Button>
      <p className="mt-3 text-center text-xs text-gray-800">You won't be charged. Cancel any time from your booking page.</p>
    </form>
  );
}
