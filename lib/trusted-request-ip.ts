import 'server-only';
import { isIP } from 'node:net';
import { headers } from 'next/headers';
import { dependencyUnavailable } from '@/lib/dependency-unavailable';

/** Vercel overwrites this header at its edge. Never trust client-supplied XFF chains. */
export async function trustedRequestIp(): Promise<string> {
  if (process.env.VERCEL !== '1') {
    // Local development has one shared identity; forged headers cannot create budgets.
    if (process.env.NODE_ENV !== 'production') return '127.0.0.1';
    throw dependencyUnavailable('trusted-client-ip');
  }
  const value = (await headers()).get('x-vercel-forwarded-for')?.trim();
  if (!value || value.includes('%') || !isIP(value)) throw dependencyUnavailable('trusted-client-ip');
  if (isIP(value) === 4) return value;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  // Normalize IPv4-mapped IPv6 to the same identity as IPv4.
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return normalized;
}
