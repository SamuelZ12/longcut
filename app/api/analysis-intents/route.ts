import { NextRequest, NextResponse } from 'next/server';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';
import { createInitialAnalysisFlow, initialAnalysisErrorResponse } from '@/lib/initial-analysis-spend';

async function handler(request: NextRequest) {
  try {
    const body = await request.json();
    return await createInitialAnalysisFlow(body?.videoId, request.signal);
  } catch (error) {
    const response = initialAnalysisErrorResponse(error);
    if (response) return response;
    if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    throw error;
  }
}

export const POST = withSecurity(handler, { ...SECURITY_PRESETS.PAID, csrfProtection: true });
