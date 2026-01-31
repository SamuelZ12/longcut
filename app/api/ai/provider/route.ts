import { NextRequest, NextResponse } from 'next/server';
import { availableProviders, getProviderKey } from '@/lib/ai-providers';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';

// GET /api/ai/provider - Get current provider
async function getHandler(req: NextRequest) {
  try {
    // Check cookie first, then fall back to default
    const cookieProvider = req.cookies.get('ai-provider')?.value;
    const provider = cookieProvider || getProviderKey();
    const available = availableProviders();

    return NextResponse.json({
      provider,
      available,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to get provider info' },
      { status: 500 }
    );
  }
}

// POST /api/ai/provider - Set provider preference (session-based)
async function postHandler(req: NextRequest) {
  try {
    const body = await req.json();
    const { provider } = body;

    const validProviders = ['grok', 'gemini', 'deepseek'] as const;

    if (!provider || !validProviders.includes(provider)) {
      return NextResponse.json(
        { error: 'Invalid provider' },
        { status: 400 }
      );
    }

    // Check if the provider has an API key configured
    const hasApiKey =
      (provider === 'grok' && process.env.XAI_API_KEY) ||
      (provider === 'gemini' && process.env.GEMINI_API_KEY) ||
      (provider === 'deepseek' && process.env.DEEPSEEK_API_KEY);

    if (!hasApiKey) {
      return NextResponse.json(
        { error: `${provider} API key is not configured` },
        { status: 400 }
      );
    }

    // Set provider preference in a cookie
    const response = NextResponse.json({
      success: true,
      provider,
    });

    response.cookies.set('ai-provider', provider, {
      httpOnly: false, // Allow client-side access for UI
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });

    return response;
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to set provider' },
      { status: 500 }
    );
  }
}

export const GET = withSecurity(getHandler, SECURITY_PRESETS.PUBLIC);

export const POST = withSecurity(postHandler, {
  ...SECURITY_PRESETS.PUBLIC,
  rateLimit: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10 // 10 requests per minute
  },
  csrfProtection: true
});
