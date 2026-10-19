import type { Metadata, Viewport } from 'next';
import { Cormorant_Garamond, Figtree, IBM_Plex_Mono } from 'next/font/google';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

const figtree = Figtree({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600'], variable: '--font-figtree' });
const cormorant = Cormorant_Garamond({ subsets: ['latin', 'latin-ext'], weight: ['500'], style: ['normal', 'italic'], variable: '--font-cormorant' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin', 'latin-ext'], weight: ['500'], variable: '--font-plex-mono' });

export const metadata: Metadata = {
  title: { default: process.env.NEXT_PUBLIC_APP_NAME ?? 'era.', template: `%s · ${process.env.NEXT_PUBLIC_APP_NAME ?? 'era.'}` },
  description: 'Property management platform for hotels',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#2c3a5a', width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading headers opts into dynamic rendering so Next can apply the per-request CSP nonce.
  await headers();
  return (
    <html lang="ro" className={`${figtree.variable} ${cormorant.variable} ${plexMono.variable}`}>
      <body className="min-h-screen font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
