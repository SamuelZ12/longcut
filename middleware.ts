import { type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

function parseHost(url: string | undefined) {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  // First, handle Supabase session update
  const response = await updateSession(request);

  // Add Content-Security-Policy and other security headers
  const supabaseHost = parseHost(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const supabaseConnectSrc = supabaseHost
    ? [`https://${supabaseHost}`, `wss://${supabaseHost}`]
    : [];

  // Define CSP directives
  const cspHeader = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.youtube.com https://s.ytimg.com https://*.googleapis.com https://js.stripe.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://i.ytimg.com https://img.youtube.com https://*.ytimg.com https://lh3.googleusercontent.com",
    "font-src 'self' data:",
    [
      "connect-src 'self'",
      'https://api.supadata.ai',
      'https://*.supabase.co',
      'https://*.supabase.in',
      'https://*.supabase.net',
      'https://*.supabase.com',
      'http://localhost:54321',
      'wss://*.supabase.co',
      'wss://*.supabase.in',
      'wss://*.supabase.net',
      'wss://*.supabase.com',
      'wss://localhost:54321',
      'https://*.googleapis.com',
      'https://www.youtube.com',
      'https://api.stripe.com',
      ...supabaseConnectSrc,
    ].join(' '),
    "media-src 'self' blob: https://www.youtube.com",
    "object-src 'none'",
    'frame-src https://www.youtube.com https://youtube.com',
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests'
  ].join('; ');

  // Apply security headers
  response.headers.set('Content-Security-Policy', cspHeader);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );

  // Add HSTS header for production
  if (process.env.NODE_ENV === 'production') {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains'
    );
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api/webhooks (webhook endpoints - must not modify request body)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * Feel free to modify this pattern to include more paths.
     */
    '/((?!api/webhooks|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'
  ]
};
