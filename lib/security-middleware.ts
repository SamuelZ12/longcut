import { NextRequest, NextResponse } from 'next/server';
import {
  RateLimiter,
  RATE_LIMITS,
  rateLimitResponse
} from '@/lib/rate-limiter';
import { AuditLogger, AuditAction } from '@/lib/audit-logger';
import { createClient } from '@/lib/supabase/server';
import {
  validateCSRF,
  injectCSRFToken,
  getCSRFTokenFromCookie,
  validateCSRFToken
} from '@/lib/csrf-protection';

export interface SecurityMiddlewareConfig {
  rateLimit?: {
    windowMs: number;
    maxRequests: number;
  };
  requireAuth?: boolean;
  maxBodySize?: number; // In bytes
  allowedMethods?: string[];
  csrfProtection?: boolean;
}

/**
 * Security middleware for API routes
 */
export function withSecurity(
  handler: (req: NextRequest) => Promise<NextResponse>,
  config: SecurityMiddlewareConfig = {}
) {
  return async function securedHandler(
    req: NextRequest
  ): Promise<NextResponse> {
    try {
      // 1. Check allowed methods
      if (
        config.allowedMethods &&
        !config.allowedMethods.includes(req.method)
      ) {
        return NextResponse.json(
          { error: 'Method not allowed' },
          { status: 405 }
        );
      }

      // 2. Check authentication if required
      if (config.requireAuth) {
        const supabase = await createClient();
        const {
          data: { user },
          error
        } = await supabase.auth.getUser();

        if (error || !user) {
          await AuditLogger.logSecurityEvent(AuditAction.UNAUTHORIZED_ACCESS, {
            endpoint: req.url
          });

          return NextResponse.json(
            { error: 'Authentication required' },
            { status: 401 }
          );
        }
      }

      // 3. Apply rate limiting
      if (config.rateLimit) {
        // Use pathname only (without query string) for consistent rate limiting
        const url = new URL(req.url);
        const rateLimitKey = url.pathname;
        const rateLimitResult = await RateLimiter.check(
          rateLimitKey,
          config.rateLimit
        );

        if (!rateLimitResult.allowed) {
          await AuditLogger.logRateLimitExceeded(req.url, 'api-endpoint');

          return (
            rateLimitResponse(rateLimitResult) ||
            NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
          );
        }
      }

      // 4. Check content size (for POST/PUT/PATCH)
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && config.maxBodySize) {
        const contentLength = req.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > config.maxBodySize) {
          return NextResponse.json(
            { error: 'Request body too large' },
            { status: 413 }
          );
        }
      }

      // 5. CSRF Protection for state-changing operations
      if (
        config.csrfProtection &&
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
      ) {
        const csrfValidation = await validateCSRF(req);
        if (!csrfValidation.valid) {
          await AuditLogger.logSecurityEvent(AuditAction.UNAUTHORIZED_ACCESS, {
            endpoint: req.url,
            reason: 'CSRF validation failed',
            error: csrfValidation.error
          });

          return NextResponse.json(
            { error: csrfValidation.error || 'CSRF validation failed' },
            { status: 403 }
          );
        }
      }

      // 6. Add security headers to response
      const response = await handler(req);

      // Add security headers
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('X-Frame-Options', 'DENY');
      response.headers.set('X-XSS-Protection', '1; mode=block');
      response.headers.set(
        'Referrer-Policy',
        'strict-origin-when-cross-origin'
      );
      response.headers.set(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=()'
      );

      // Add CORS headers if needed (configure as per your requirements)
      const origin = req.headers.get('origin');
      if (origin && isAllowedOrigin(origin)) {
        response.headers.set('Access-Control-Allow-Origin', origin);
        response.headers.set('Access-Control-Allow-Credentials', 'true');
      }

      // Inject CSRF token only if missing or invalid to avoid unnecessary rotation
      if (config.csrfProtection) {
        const existingToken = getCSRFTokenFromCookie(req);
        const hasValidToken = validateCSRFToken(existingToken, existingToken);
        if (!hasValidToken) {
          const { response: csrfResponse } = injectCSRFToken(response);
          return csrfResponse;
        }
      }

      return response;
    } catch (error) {
      // Log unexpected errors
      console.error('Security middleware error:', error);

      // Don't leak error details
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      );
    }
  };
}

/**
 * Check if origin is allowed for CORS
 */
function isAllowedOrigin(origin: string): boolean {
  const allowedOrigins = [
    process.env.NEXT_PUBLIC_APP_URL,
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002'
  ].filter(Boolean);

  return allowedOrigins.includes(origin);
}

/**
 * Preset security configurations
 */
export const SECURITY_PRESETS = {
  PUBLIC: {
    rateLimit: RATE_LIMITS.API_GENERAL,
    maxBodySize: 1024 * 1024, // 1MB
    allowedMethods: ['GET', 'POST']
  },
  AUTHENTICATED: {
    requireAuth: true,
    rateLimit: RATE_LIMITS.AUTH_GENERATION,
    maxBodySize: 5 * 1024 * 1024, // 5MB
    allowedMethods: ['GET', 'POST', 'PUT', 'DELETE'],
    csrfProtection: true
  },
  AUTHENTICATED_READ_ONLY: {
    requireAuth: true,
    rateLimit: RATE_LIMITS.READ_ONLY,
    maxBodySize: 1024 * 1024, // 1MB
    allowedMethods: ['GET'],
    csrfProtection: false
  },
  STRICT: {
    requireAuth: true,
    rateLimit: {
      windowMs: 60 * 1000,
      maxRequests: 10
    },
    maxBodySize: 512 * 1024, // 512KB
    allowedMethods: ['POST'],
    csrfProtection: true
  }
};
