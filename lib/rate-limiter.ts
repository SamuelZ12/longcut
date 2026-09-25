import { createClient } from '@/lib/supabase/server';
import type { SubscriptionTier } from '@/lib/subscription-manager';
import crypto from 'crypto';
import { trustedRequestIp } from '@/lib/trusted-request-ip';
import { NextResponse } from 'next/server';
import { limiterDecision } from '@/lib/limiter-store';
import { dependencyUnavailable } from '@/lib/dependency-unavailable';

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  identifier?: string;
  failClosed?: boolean;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfter?: number;
}

export class RateLimiter {
  private static async getIdentifier(customId?: string): Promise<string> {
    if (customId) return customId;
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error && error.name !== 'AuthSessionMissingError') throw dependencyUnavailable('auth', error);
    if (user) return `user:${user.id}`;
    const ip = await trustedRequestIp();
    return `anon:${crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16)}`;
  }

  private static async decide(key: string, config: RateLimitConfig, consume: boolean): Promise<RateLimitResult> {
    try {
      const identifier = await this.getIdentifier(config.identifier);
      return await limiterDecision(`ratelimit:${key}:${identifier}`, identifier, config.windowMs, config.maxRequests, consume);
    } catch (error) {
      // Only non-spending/read-only controls may degrade when persistence is unavailable.
      if (config.failClosed) throw dependencyUnavailable('required-rate-limit', error);
      return { allowed: true, remaining: config.maxRequests, resetAt: new Date(Date.now() + config.windowMs) };
    }
  }

  static peek(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
    return this.decide(key, config, false);
  }

  static check(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
    return this.decide(key, config, true);
  }
}

export const RATE_LIMITS = {
  ANON_GENERATION: { windowMs: 24 * 60 * 60 * 1000, maxRequests: 1 },
  ANON_CHAT: { windowMs: 60 * 1000, maxRequests: 10, failClosed: true },
  AUTH_GENERATION: { windowMs: 60 * 60 * 1000, maxRequests: 20 },
  AUTH_VIDEO_GENERATION: { windowMs: 24 * 60 * 60 * 1000, maxRequests: 5 },
  AUTH_CHAT: { windowMs: 60 * 1000, maxRequests: 30, failClosed: true },
  SUGGESTED_QUESTIONS: { windowMs: 60 * 1000, maxRequests: 20 },
  VIDEO_GENERATION_FREE_UNREGISTERED: { windowMs: 30 * 24 * 60 * 60 * 1000, maxRequests: 0 },
  VIDEO_GENERATION_FREE_REGISTERED: { windowMs: 30 * 24 * 60 * 60 * 1000, maxRequests: 3 },
  VIDEO_GENERATION_PRO: { windowMs: 30 * 24 * 60 * 60 * 1000, maxRequests: 100 },
  API_GENERAL: { windowMs: 60 * 1000, maxRequests: 60 },
  AUTH_ATTEMPT: { windowMs: 15 * 60 * 1000, maxRequests: 5 },
  ANON_TRANSLATION: { windowMs: 60 * 1000, maxRequests: 100, failClosed: true },
  AUTH_TRANSLATION: { windowMs: 60 * 1000, maxRequests: 500, failClosed: true },
  READ_ONLY: { windowMs: 60 * 1000, maxRequests: 100 }
};

export function rateLimitResponse(result: RateLimitResult): NextResponse | null {
  if (result.allowed) return null;
  const retryAfter = Math.max(1, result.retryAfter ?? 60);
  return NextResponse.json({
    error: 'Rate limit exceeded',
    message: `Too many requests. Please try again in ${retryAfter} seconds.`,
    retryAfter, resetAt: result.resetAt,
  }, { status: 429, headers: {
    'Retry-After': String(retryAfter),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': result.resetAt.toISOString(),
  } });
}

export function getPlanLimiter(tier: SubscriptionTier | 'anonymous'): RateLimitConfig {
  switch (tier) {
    case 'pro': return RATE_LIMITS.VIDEO_GENERATION_PRO;
    case 'free': return RATE_LIMITS.VIDEO_GENERATION_FREE_REGISTERED;
    default: return RATE_LIMITS.VIDEO_GENERATION_FREE_UNREGISTERED;
  }
}
