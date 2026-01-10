import { NextRequest, NextResponse } from 'next/server';
import * as postmark from 'postmark';
import { LinkTrackingOptions } from 'postmark/dist/client/models/message/SupportingTypes';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import { getWelcomeSubject, getWelcomeHtmlBody } from '@/lib/email/templates/welcome';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Validation schema for the request body
const requestSchema = z.object({
  emailId: z.string().uuid(),
  userId: z.string().uuid(),
  email: z.string().email(),
  fullName: z.string().nullable().optional(),
});

// Validate internal API key - this endpoint is only called by pg_net
function validateInternalApiKey(req: NextRequest): boolean {
  const apiKey = req.headers.get('X-Internal-API-Key');
  const expectedKey = process.env.INTERNAL_API_KEY;

  if (!expectedKey) {
    console.error('INTERNAL_API_KEY environment variable not set');
    return false;
  }

  return apiKey === expectedKey;
}

export async function POST(req: NextRequest) {
  // Validate internal API key
  if (!validateInternalApiKey(req)) {
    console.error('Invalid or missing internal API key for welcome email');
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  // Validate Postmark configuration
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  if (!postmarkToken) {
    console.error('POSTMARK_SERVER_TOKEN not configured');
    return NextResponse.json(
      { error: 'Email service not configured' },
      { status: 500 }
    );
  }

  try {
    // Parse and validate request body
    const body = await req.json();
    const parseResult = requestSchema.safeParse(body);

    if (!parseResult.success) {
      console.error('Invalid request body for welcome email:', parseResult.error.format());
      return NextResponse.json(
        { error: 'Invalid request body', details: parseResult.error.format() },
        { status: 400 }
      );
    }

    const { emailId, userId, email, fullName } = parseResult.data;

    // Check if user still exists (they might have deleted their account)
    const supabase = createServiceRoleClient();
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, email')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      console.log(`User ${userId} no longer exists, skipping welcome email`);

      // Mark as cancelled in the database
      // Type assertion needed until TypeScript types are regenerated after migration
      await (supabase as unknown as { from: (table: string) => ReturnType<typeof supabase.from> })
        .from('pending_welcome_emails')
        .update({
          status: 'cancelled',
          last_error: 'User account no longer exists',
          updated_at: new Date().toISOString()
        })
        .eq('id', emailId);

      return NextResponse.json({
        success: false,
        reason: 'user_not_found'
      });
    }

    // Initialize Postmark client and send email
    const client = new postmark.ServerClient(postmarkToken);

    const result = await client.sendEmail({
      From: 'zara@longcut.ai',
      To: email,
      Subject: getWelcomeSubject(),
      HtmlBody: getWelcomeHtmlBody(fullName),
      MessageStream: 'outbound', // Transactional email stream
      TrackOpens: true,
      TrackLinks: LinkTrackingOptions.HtmlAndText,
    });

    console.log(`Welcome email sent to ${email} (MessageID: ${result.MessageID})`);

    return NextResponse.json({
      success: true,
      messageId: result.MessageID,
    });

  } catch (error) {
    console.error('Error sending welcome email:', error);

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return NextResponse.json(
      { error: 'Failed to send email', details: errorMessage },
      { status: 500 }
    );
  }
}
