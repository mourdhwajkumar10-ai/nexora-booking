import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import type { Locality } from '@nexora/shared';
import { Logo } from '@/components/ui/logo';
import { LocalitySelect } from './locality-select';

export function SiteHeader({ localities, current }: { localities: Locality[]; current: string | null }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" aria-label="Nexora home" className="shrink-0 rounded-md">
          <Logo />
        </Link>
        <span aria-hidden className="hidden h-5 w-px bg-border sm:block" />
        {localities.length > 0 && current ? <LocalitySelect localities={localities} value={current} /> : null}
        <nav className="ml-auto flex items-center">
          <Link
            href="/admin/login"
            className="inline-flex h-9 items-center gap-1 rounded-md px-2.5 text-[13px] font-medium text-gray-900 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-1000"
          >
            <span className="hidden sm:inline">For restaurants</span>
            <span className="sm:hidden">Partners</span>
            <ArrowUpRight size={14} aria-hidden />
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-border bg-background-2">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="space-y-2">
          <Logo />
          <p className="max-w-xs text-[13px] text-gray-900">Reserve a table at the best restaurants near you. No fees, no fuss.</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-gray-900">
          <Link href="/" className="hover:text-gray-1000">
            Discover
          </Link>
          <Link href="/admin/login" className="hover:text-gray-1000">
            For restaurants
          </Link>
          <span className="text-gray-700">© {new Date().getFullYear()} Nexora</span>
        </nav>
      </div>
    </footer>
  );
}
