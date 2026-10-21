import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Instrument_Sans, Instrument_Serif } from 'next/font/google';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

const sans = Instrument_Sans({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600', '700'], variable: '--font-instrument-sans' });
const serif = Instrument_Serif({ subsets: ['latin', 'latin-ext'], weight: ['400'], style: ['normal', 'italic'], variable: '--font-instrument-serif' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin', 'latin-ext'], weight: ['500'], variable: '--font-plex-mono' });

export const metadata: Metadata = {
  title: { default: process.env.NEXT_PUBLIC_APP_NAME ?? 'era.', template: `%s · ${process.env.NEXT_PUBLIC_APP_NAME ?? 'era.'}` },
  description: 'Property management platform for hotels',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#ece9e2', width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading headers opts into dynamic rendering so Next can apply the per-request CSP nonce.
  await headers();
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${plexMono.variable}`}>
      <body className="min-h-screen font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
