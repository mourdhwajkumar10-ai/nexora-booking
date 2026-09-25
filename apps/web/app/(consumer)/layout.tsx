import type { Locality } from '@nexora/shared';
import { SiteFooter, SiteHeader } from '@/components/consumer/site-chrome';
import { getLocalities, resolveLocality } from '@/components/consumer/data';

export default async function ConsumerLayout({ children }: { children: React.ReactNode }) {
  // The header must render even when the API is down; pages show their own error states.
  let localities: Locality[] = [];
  try {
    localities = await getLocalities();
  } catch {
    /* API unreachable */
  }
  const current = await resolveLocality(localities);

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-gray-1000 px-3 py-2 text-sm text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <SiteHeader localities={localities} current={current?.slug ?? null} />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
