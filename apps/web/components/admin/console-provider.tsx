'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AlertDto, MeResponse, NotificationDto, ServerToClientEvents, VenueSettings } from '@nexora/shared';
import { getSocket } from '@/lib/socket';
import { adminApi, apiMessage, send } from './admin-api';
import { serverNow, setServerTime } from './clock';

/** Invalidation signals pages can subscribe to. `poll` is the 15 s fallback (also fired on reconnect/focus). */
export type ConsoleEventName =
  | 'floor:changed'
  | 'reservation:changed'
  | 'order:changed'
  | 'alert:new'
  | 'notification:sent'
  | 'venue:changed'
  | 'poll';

type Listener = (event: ConsoleEventName, payload: unknown) => void;
export type ConnectionState = 'connecting' | 'live' | 'offline';

interface ConsoleContextValue {
  venueId: string;
  me: MeResponse;
  isManager: boolean;
  venueName: string;
  timezone: string;
  settings: VenueSettings | null;
  connection: ConnectionState;
  alerts: AlertDto[];
  ackAlert: (id: string) => Promise<void>;
  /** Server-synchronised "now" in ms. */
  nowServer: () => number;
  subscribe: (events: readonly ConsoleEventName[], fn: Listener) => () => void;
  /** Broadcast a local invalidation (e.g. after a mutation on another page section). */
  emit: (event: ConsoleEventName, payload?: unknown) => void;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function useConsole(): ConsoleContextValue {
  const ctx = useContext(ConsoleContext);
  if (!ctx) throw new Error('useConsole must be used inside <ConsoleProvider>');
  return ctx;
}

const POLL_MS = 15_000;

export function ConsoleProvider({
  venueId,
  me,
  initialSettings,
  children,
}: {
  venueId: string;
  me: MeResponse;
  initialSettings: VenueSettings | null;
  children: React.ReactNode;
}) {
  const listeners = useRef(new Set<{ events: ReadonlySet<ConsoleEventName>; fn: Listener }>());
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [settings, setSettings] = useState<VenueSettings | null>(initialSettings);
  const [alerts, setAlerts] = useState<AlertDto[]>([]);
  const [announce, setAnnounce] = useState<{ polite: string; assertive: string }>({ polite: '', assertive: '' });

  const emit = useCallback((event: ConsoleEventName, payload?: unknown) => {
    for (const l of listeners.current) if (l.events.has(event)) l.fn(event, payload);
  }, []);

  const subscribe = useCallback((events: readonly ConsoleEventName[], fn: Listener) => {
    const entry = { events: new Set(events), fn };
    listeners.current.add(entry);
    return () => {
      listeners.current.delete(entry);
    };
  }, []);

  // ----- venue settings (name, timezone, blackout) -----
  const loadSettings = useCallback(async () => {
    try {
      setSettings(await adminApi<VenueSettings>(`/admin/venues/${venueId}`));
    } catch {
      /* keep last known */
    }
  }, [venueId]);

  // ----- alerts -----
  const loadAlerts = useCallback(async () => {
    try {
      const list = await adminApi<AlertDto[]>(`/admin/venues/${venueId}/alerts`);
      setAlerts(list.filter((a) => !a.acknowledgedAt));
    } catch {
      /* keep last known */
    }
  }, [venueId]);

  const ackAlert = useCallback(
    async (id: string) => {
      let removed: AlertDto | undefined;
      setAlerts((prev) => {
        removed = prev.find((a) => a.id === id);
        return prev.filter((a) => a.id !== id);
      });
      toast.dismiss(id);
      try {
        await send<AlertDto>('POST', `/admin/alerts/${id}/ack`);
        emit('alert:new');
      } catch (e) {
        if (removed) {
          const restore = removed;
          setAlerts((prev) => (prev.some((a) => a.id === id) ? prev : [restore, ...prev]));
        }
        toast.error('Could not acknowledge alert', { description: apiMessage(e) });
      }
    },
    [emit],
  );

  const ackRef = useRef(ackAlert);
  useEffect(() => {
    ackRef.current = ackAlert;
  }, [ackAlert]);

  const onAlert = useCallback(
    (a: AlertDto) => {
      if (a.venueId !== venueId) return;
      setAlerts((prev) => (prev.some((x) => x.id === a.id) ? prev : [a, ...prev]));
      const opts = {
        id: a.id,
        description: a.body,
        duration: a.severity === 'critical' ? Number.POSITIVE_INFINITY : 8000,
        action: { label: 'Acknowledge', onClick: () => void ackRef.current(a.id) },
      };
      if (a.severity === 'critical') toast.error(a.title, opts);
      else if (a.severity === 'warning') toast.warning(a.title, opts);
      else toast.info(a.title, opts);
      const text = `${a.severity === 'critical' ? 'Critical alert' : 'Alert'}: ${a.title}. ${a.body}`;
      setAnnounce((s) => (a.severity === 'critical' ? { ...s, assertive: text } : { ...s, polite: text }));
    },
    [venueId],
  );

  // ----- initial loads + server clock -----
  useEffect(() => {
    void loadAlerts();
    const t0 = Date.now();
    adminApi<{ serverTime: string }>('/time')
      .then((r) => setServerTime(r.serverTime, Date.now() - t0))
      .catch(() => undefined);
  }, [loadAlerts]);

  // ----- socket -----
  useEffect(() => {
    const socket = getSocket();
    let joinedOnce = false;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;

    const join = () => {
      setConnection('connecting');
      if (ackTimer) clearTimeout(ackTimer);
      ackTimer = setTimeout(() => setConnection(socket.connected ? 'live' : 'offline'), 5000);
      socket.emit('venue:join', venueId, (ok: boolean) => {
        if (ackTimer) clearTimeout(ackTimer);
        setConnection(ok ? 'live' : 'offline');
        if (!ok) toast.error('Realtime updates unavailable', { description: 'Falling back to polling every 15 seconds.' });
      });
      if (joinedOnce) emit('poll'); // catch up on anything missed while disconnected
      joinedOnce = true;
    };
    const onDisconnect = () => setConnection('offline');
    const onTime: ServerToClientEvents['server:time'] = (p) => setServerTime(p.serverTime);
    const onFloor: ServerToClientEvents['floor:changed'] = (p) => {
      if (p.venueId !== venueId) return;
      setServerTime(p.serverTime);
      emit('floor:changed', p);
    };
    const onReservation: ServerToClientEvents['reservation:changed'] = (p) => {
      if (p.venueId !== venueId) return;
      setServerTime(p.serverTime);
      emit('reservation:changed', p);
    };
    const onOrder: ServerToClientEvents['order:changed'] = (p) => {
      if (p.venueId !== venueId) return;
      setServerTime(p.serverTime);
      emit('order:changed', p);
    };
    const onAlertNew: ServerToClientEvents['alert:new'] = (p) => {
      onAlert(p);
      if (p.venueId === venueId) emit('alert:new', p);
    };
    const onNotification: ServerToClientEvents['notification:sent'] = (p: NotificationDto & { venueId: string }) => {
      if (p.venueId !== venueId) return;
      emit('notification:sent', p);
    };

    if (socket.connected) join();
    socket.on('connect', join);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onDisconnect);
    socket.on('server:time', onTime);
    socket.on('floor:changed', onFloor);
    socket.on('reservation:changed', onReservation);
    socket.on('order:changed', onOrder);
    socket.on('alert:new', onAlertNew);
    socket.on('notification:sent', onNotification);
    if (!socket.connected && socket.disconnected) socket.connect();

    return () => {
      if (ackTimer) clearTimeout(ackTimer);
      socket.off('connect', join);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onDisconnect);
      socket.off('server:time', onTime);
      socket.off('floor:changed', onFloor);
      socket.off('reservation:changed', onReservation);
      socket.off('order:changed', onOrder);
      socket.off('alert:new', onAlertNew);
      socket.off('notification:sent', onNotification);
    };
  }, [venueId, emit, onAlert]);

  // ----- 15 s polling fallback + revalidate on focus -----
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      emit('poll');
      void loadAlerts();
      void loadSettings();
    };
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [emit, loadAlerts, loadSettings]);

  useEffect(() => subscribe(['venue:changed'], () => void loadSettings()), [subscribe, loadSettings]);

  const venueName = settings?.name ?? me.venues.find((v) => v.id === venueId)?.name ?? 'Venue';
  const timezone = settings?.timezone ?? 'Asia/Kolkata';

  const value = useMemo<ConsoleContextValue>(
    () => ({
      venueId,
      me,
      isManager: me.user.role === 'MANAGER',
      venueName,
      timezone,
      settings,
      connection,
      alerts,
      ackAlert,
      nowServer: serverNow,
      subscribe,
      emit,
    }),
    [venueId, me, venueName, timezone, settings, connection, alerts, ackAlert, subscribe, emit],
  );

  return (
    <ConsoleContext.Provider value={value}>
      {children}
      <div aria-live="polite" role="status" className="sr-only">
        {announce.polite}
      </div>
      <div aria-live="assertive" role="alert" className="sr-only">
        {announce.assertive}
      </div>
    </ConsoleContext.Provider>
  );
}
