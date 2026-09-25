import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { api, ApiRequestError } from '@/lib/api';
import { WifiPortalClient, type VenueWifiDto } from './wifi-client';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  try {
    const data = await api<{ venue: VenueWifiDto }>(`/wifi/${encodeURIComponent(slug)}`);
    return {
      title: `${data.venue.name} Guest Wi-Fi · Nexora`,
      description: `Connect to high-speed guest Wi-Fi at ${data.venue.name}.`,
    };
  } catch {
    return { title: 'Guest Wi-Fi Portal · Nexora' };
  }
}

export default async function WifiPortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ mac?: string; ap?: string }>;
}) {
  const { slug } = await params;
  const { mac, ap } = await searchParams;

  let venue: VenueWifiDto;
  try {
    const res = await api<{ venue: VenueWifiDto }>(`/wifi/${encodeURIComponent(slug)}`);
    venue = res.venue;
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) {
      notFound();
    }
    // Fallback: If API is temporarily disconnected in dev, provide a mock venue shell
    venue = {
      name: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      slug,
      imageUrl: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4',
    };
  }

  return (
    <WifiPortalClient
      venue={venue}
      initialMac={typeof mac === 'string' ? mac : undefined}
      initialAp={typeof ap === 'string' ? ap : undefined}
    />
  );
}
