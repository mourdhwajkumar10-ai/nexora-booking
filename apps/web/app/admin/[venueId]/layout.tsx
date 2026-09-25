import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { MeResponse, VenueSettings } from '@nexora/shared';
import { api, ApiRequestError } from '@/lib/api';
import { ConsoleShell } from '@/components/admin/console-shell';

export default async function AdminVenueLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ venueId: string }>;
}) {
  const { venueId } = await params;
  const cookieStore = await cookies();
  const cookie = cookieStore.toString();

  let me: MeResponse;
  try {
    me = await api<MeResponse>('/auth/me', { cookie });
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) {
      redirect(`/admin/login?next=${encodeURIComponent(`/admin/${venueId}/floor`)}`);
    }
    // Network or other error, redirect to login
    redirect('/admin/login');
  }

  // Validate venue access
  const hasAccess =
    me.user.venueId === null || me.venues.some((v) => v.id === venueId);

  if (!hasAccess && me.venues.length > 0) {
    redirect(`/admin/${me.venues[0].id}/floor`);
  }

  let venueSettings: VenueSettings | null = null;
  try {
    venueSettings = await api<VenueSettings>(`/admin/venues/${venueId}`, { cookie });
  } catch {
    venueSettings = null;
  }

  return (
    <ConsoleShell venueId={venueId} me={me} initialSettings={venueSettings}>
      {children}
    </ConsoleShell>
  );
}
