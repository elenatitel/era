import { type NextRequest, NextResponse } from 'next/server';

/** Per-request nonce-based Content Security Policy. */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  // Card payments (Stripe Payment Element) are only loaded on the guest booking pages.
  const stripe = request.nextUrl.pathname.startsWith('/book/');
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${stripe ? ' https://js.stripe.com' : ''}${isDev ? ` 'unsafe-eval'` : ''}`,
    // Inline style attributes are used for layout (calendar bars); scripts stay nonce-locked.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:${stripe ? ' https://*.stripe.com' : ''}`,
    `font-src 'self'`,
    `connect-src 'self'${stripe ? ' https://api.stripe.com' : ''}${isDev ? ' ws:' : ''}`,
    `frame-src ${stripe ? 'https://js.stripe.com https://hooks.stripe.com' : "'none'"}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
