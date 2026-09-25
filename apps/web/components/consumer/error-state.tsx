'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CloudOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/** Friendly "we can't reach the server" block with a retry that re-renders server components. */
export function ErrorState({
  title = "We can't reach Nexora right now",
  description = 'Our servers might be taking a breather. Check your connection and try again.',
  onRetry,
  className,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div role="alert" className={cn('flex flex-col items-center rounded-xl border border-border bg-background-2 px-6 py-14 text-center', className)}>
      <span className="mb-4 grid size-10 place-items-center rounded-full border border-border bg-background text-gray-900">
        <CloudOff size={18} aria-hidden />
      </span>
      <p className="text-[15px] font-semibold tracking-tight">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-gray-900">{description}</p>
      <Button
        variant="secondary"
        size="sm"
        className="mt-5"
        loading={pending}
        onClick={() => startTransition(() => (onRetry ? onRetry() : router.refresh()))}
      >
        Try again
      </Button>
    </div>
  );
}
