'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { AlertDto, MeResponse, VenueSettings } from '@nexora/shared';
import { ConsoleProvider, useConsole } from './console-provider';
import { send } from './admin-api';
import { Badge, Button, Logo } from '@/components/ui';
import {
  Activity,
  Bell,
  Calendar,
  Check,
  CreditCard,
  Inbox,
  LayoutGrid,
  LogOut,
  Receipt,
  Settings as SettingsIcon,
  Sliders,
  Users,
  X,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/cn';

interface ConsoleShellProps {
  venueId: string;
  me: MeResponse;
  initialSettings: VenueSettings | null;
  children: React.ReactNode;
}

const NAV_ITEMS = [
  { label: 'Floor', segment: 'floor', icon: LayoutGrid },
  { label: 'Triage', segment: 'triage', icon: Inbox },
  { label: 'Reservations', segment: 'reservations', icon: Calendar },
  { label: 'Guests', segment: 'guests', icon: Users },
  { label: 'POS & Voids', segment: 'pos', icon: Receipt },
  { label: 'Payments', segment: 'payments', icon: CreditCard },
  { label: 'Settings', segment: 'settings', icon: Sliders },
  { label: 'Activity & Logs', segment: 'activity', icon: Activity },
];

function ConnectionPill() {
  const { connection } = useConsole();

  const configs = {
    live: { dot: 'bg-success', label: 'Live', text: 'text-success-fg', bg: 'bg-success-soft border-success/20' },
    connecting: { dot: 'bg-amber animate-pulse', label: 'Connecting', text: 'text-amber-fg', bg: 'bg-amber-soft border-amber/25' },
    offline: { dot: 'bg-red', label: 'Offline', text: 'text-red-fg', bg: 'bg-red-soft border-red/20' },
  };

  const current = configs[connection] ?? configs.connecting;

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
        current.bg,
        current.text,
      )}
      title={`Realtime status: ${current.label}`}
    >
      <span className={cn('size-1.5 rounded-full', current.dot)} />
      <span>{current.label}</span>
    </div>
  );
}

function AlertsPopover() {
  const { alerts, ackAlert } = useConsole();
  const [open, setOpen] = useState(false);
  const [ackingId, setAckingId] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  async function handleAck(id: string) {
    setAckingId(id);
    try {
      await ackAlert(id);
    } finally {
      setAckingId(null);
    }
  }

  const unreadCount = alerts.length;

  return (
    <div className="relative" ref={popoverRef}>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(!open)}
        className="relative h-9 w-9 text-gray-900 hover:text-gray-1000"
        aria-label={`Alerts (${unreadCount} unacknowledged)`}
      >
        <Bell size={17} />
        {unreadCount > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red px-1 text-[10px] font-semibold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        ) : null}
      </Button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 sm:w-96 rounded-xl border border-border bg-background p-0 shadow-lg animate-fade-in">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-900">Active Alerts</h3>
              <Badge tone={unreadCount > 0 ? 'amber' : 'neutral'} className="h-5 px-1.5 text-[10px]">
                {unreadCount}
              </Badge>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-gray-700 hover:bg-gray-100 hover:text-gray-1000"
            >
              <X size={14} />
            </button>
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-border">
            {alerts.length === 0 ? (
              <div className="py-8 text-center text-xs text-gray-700">
                No active alerts. All operations normal.
              </div>
            ) : (
              alerts.map((alert) => {
                const severityTone =
                  alert.severity === 'critical'
                    ? 'red'
                    : alert.severity === 'warning'
                      ? 'amber'
                      : 'blue';

                return (
                  <div key={alert.id} className="p-3.5 transition-colors hover:bg-background-2">
                    <div className="flex items-start justify-between gap-2">
                      <Badge tone={severityTone} className="h-5 text-[10px] uppercase font-semibold">
                        {alert.severity}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={ackingId === alert.id}
                        onClick={() => void handleAck(alert.id)}
                        className="h-6 px-2 text-[11px] font-normal text-gray-800 hover:text-gray-1000"
                      >
                        <Check size={12} className="mr-1" />
                        Acknowledge
                      </Button>
                    </div>
                    <h4 className="mt-1.5 text-xs font-semibold text-gray-1000 leading-snug">{alert.title}</h4>
                    <p className="mt-1 text-xs text-gray-800 leading-relaxed">{alert.body}</p>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConsoleLayoutInner({ children }: { children: React.ReactNode }) {
  const { venueId, me, isManager, venueName } = useConsole();
  const router = useRouter();
  const pathname = usePathname();

  async function handleLogout() {
    try {
      await send('POST', '/auth/logout');
    } catch {
      // Proceed with redirect anyway
    }
    router.push('/admin/login');
    router.refresh();
  }

  function handleVenueChange(newVenueId: string) {
    if (newVenueId === venueId) return;
    // Replace current venueId segment in url with newVenueId
    const currentSegment = pathname.split('/')[3] ?? 'floor';
    router.push(`/admin/${newVenueId}/${currentSegment}`);
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-gray-1000 antialiased">
      {/* Left Sidebar */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-background-2">
        {/* Brand header */}
        <div className="flex h-14 items-center justify-between border-b border-border px-4">
          <Link href={`/admin/${venueId}/floor`} className="focus:outline-none">
            <Logo subtitle="Admin" />
          </Link>
        </div>

        {/* Venue Switcher */}
        <div className="border-b border-border p-3">
          {me.venues.length > 1 ? (
            <div className="relative">
              <label htmlFor="venue-switcher" className="sr-only">Switch Venue</label>
              <select
                id="venue-switcher"
                value={venueId}
                onChange={(e) => handleVenueChange(e.target.value)}
                className="w-full appearance-none rounded-md border border-border bg-background py-1.5 pl-3 pr-8 text-xs font-medium text-gray-1000 hover:border-border-strong focus:outline-none focus:ring-1 focus:ring-gray-1000"
              >
                {me.venues.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.localityLabel.split(',')[0]})
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-800" />
            </div>
          ) : (
            <div className="px-1 py-0.5">
              <div className="text-xs font-medium text-gray-1000 truncate">{venueName}</div>
              <div className="text-[11px] text-gray-800">
                {me.venues[0]?.localityLabel ?? 'Venue'}
              </div>
            </div>
          )}
        </div>

        {/* Navigation links */}
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {NAV_ITEMS.map((item) => {
            const href = `/admin/${venueId}/${item.segment}`;
            const isActive = pathname.startsWith(href);
            const Icon = item.icon;

            return (
              <Link
                key={item.segment}
                href={href}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-xs font-medium transition-colors duration-150',
                  isActive
                    ? 'bg-gray-200 text-gray-1000 font-semibold shadow-sm'
                    : 'text-gray-900 hover:bg-gray-100 hover:text-gray-1000',
                )}
              >
                <Icon size={16} className={cn('shrink-0', isActive ? 'text-gray-1000' : 'text-gray-800')} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Operator Profile Footer */}
        <div className="border-t border-border p-3">
          <div className="flex items-center justify-between gap-2 rounded-lg bg-background border border-border p-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-gray-1000">{me.user.name}</div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <Badge
                  tone={isManager ? 'accent' : 'neutral'}
                  className="h-4 px-1.5 text-[9px] font-semibold tracking-wider uppercase"
                >
                  {me.user.role}
                </Badge>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void handleLogout()}
              title="Logout"
              className="h-7 w-7 text-gray-800 hover:text-red hover:bg-red-soft"
            >
              <LogOut size={14} />
            </Button>
          </div>
        </div>
      </aside>

      {/* Main Console Area */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Top Navigation Bar */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-6">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold tracking-tight text-gray-1000">{venueName}</h2>
          </div>

          <div className="flex items-center gap-3">
            <ConnectionPill />
            <div className="h-4 w-px bg-border" />
            <AlertsPopover />
            <div className="h-4 w-px bg-border" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleLogout()}
              className="text-xs text-gray-800 hover:text-red"
            >
              Logout
            </Button>
          </div>
        </header>

        {/* Scrollable Children */}
        <main className="flex-1 overflow-y-auto bg-background-2 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

export function ConsoleShell({ venueId, me, initialSettings, children }: ConsoleShellProps) {
  return (
    <ConsoleProvider venueId={venueId} me={me} initialSettings={initialSettings}>
      <ConsoleLayoutInner>{children}</ConsoleLayoutInner>
    </ConsoleProvider>
  );
}
