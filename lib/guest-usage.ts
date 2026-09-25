import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { guestUsage } from '@/lib/limiter-store'
import { trustedRequestIp } from '@/lib/trusted-request-ip'

const GUEST_TOKEN_COOKIE = 'tldw_guest_token'
const GUEST_USED_COOKIE = 'tldw_guest_analysis_used'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 5 // 5 years

export type GuestAccessState = {
  token: string
  tokenNeedsSet: boolean
  used: boolean
  identifiers: string[]
}

async function getIpHash(): Promise<string> {
  const rawIp = await trustedRequestIp()
  return crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 32)
}

export async function getGuestAccessState(): Promise<GuestAccessState> {
  const cookieStore = await cookies()

  const rawToken = cookieStore.get(GUEST_TOKEN_COOKIE)?.value
  const existingToken = rawToken && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawToken)
    ? rawToken.toLowerCase() : undefined
  const token = existingToken || crypto.randomUUID()
  const tokenNeedsSet = !existingToken

  const ipHash = await getIpHash()
  const identifiers = [token]
  if (ipHash) {
    identifiers.push(`ip:${ipHash}`)
  }

  const usedCookie = cookieStore.get(GUEST_USED_COOKIE)?.value === '1'
  let used = usedCookie

  if (!used) {
    used = await guestUsage(identifiers)
  }

  return {
    token,
    tokenNeedsSet,
    used,
    identifiers
  }
}

export function setGuestCookies(
  response: NextResponse,
  state: GuestAccessState,
  options?: { markUsed?: boolean }
): void {
  const cookieConfig = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE
  }

  if (state.tokenNeedsSet) {
    response.cookies.set(GUEST_TOKEN_COOKIE, state.token, cookieConfig)
  }

  if (options?.markUsed) {
    response.cookies.set(GUEST_USED_COOKIE, '1', cookieConfig)
  }
}

export async function recordGuestUsage(
  state: GuestAccessState
): Promise<void> {
  await guestUsage(state.identifiers, true)
}
