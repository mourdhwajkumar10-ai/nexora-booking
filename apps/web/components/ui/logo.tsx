import { cn } from '@/lib/cn';

/** Nexora wordmark: a monogram tile + Geist wordmark. */
export function Logo({ className, subtitle }: { className?: string; subtitle?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
        <rect width="24" height="24" rx="6" fill="#171717" />
        <path d="M7 17V7l10 10V7" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">Nexora</span>
      {subtitle ? <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-gray-900">{subtitle}</span> : null}
    </span>
  );
}
