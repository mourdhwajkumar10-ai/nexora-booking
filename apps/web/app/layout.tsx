import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Toaster } from 'sonner';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Nexora — Reserve a table', template: '%s · Nexora' },
  description: 'Discover restaurants near you and reserve a table in seconds.',
};

export const viewport: Viewport = {
  themeColor: '#ffffff',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh bg-background">
        {children}
        <Toaster position="bottom-right" toastOptions={{ className: 'font-sans' }} />
      </body>
    </html>
  );
}
