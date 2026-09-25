import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getReservation } from '@/components/consumer/data';
import { BookingTrackerClient } from './tracker-client';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const res = await getReservation(token);
  if (!res) return { title: 'Reservation Tracker · Nexora' };

  const statusNice = res.status.replace(/_/g, ' ').toLowerCase();
  return {
    title: `Reservation at ${res.venue.name} (${statusNice}) · Nexora`,
    description: `Track your table reservation status at ${res.venue.name}.`,
  };
}

export default async function BookingTrackerPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const reservation = await getReservation(token);

  if (!reservation) {
    notFound();
  }

  return <BookingTrackerClient token={token} initialReservation={reservation} />;
}
