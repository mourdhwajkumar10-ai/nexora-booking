'use client';

import { ErrorState } from '@/components/consumer/error-state';

export default function ConsumerError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <ErrorState title="Something went wrong" description="We couldn't load this page. It's not you, it's us." onRetry={retry} />
    </div>
  );
}
