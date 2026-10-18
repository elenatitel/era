import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: process.env.NEXT_PUBLIC_APP_NAME ?? 'HotelPMS', template: `%s · ${process.env.NEXT_PUBLIC_APP_NAME ?? 'HotelPMS'}` },
  description: 'Property management platform for hotels',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#e8552d', width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading headers opts into dynamic rendering so Next can apply the per-request CSP nonce.
  await headers();
  return (
    <html lang="ro">
      <body className="min-h-screen font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
