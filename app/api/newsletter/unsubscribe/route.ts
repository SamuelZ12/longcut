import { createServiceRoleClient } from '../../../../lib/supabase/admin';
import { NextResponse } from 'next/server';
import { verifyUnsubscribeToken } from '@/lib/newsletter-security';

export async function POST(request: Request) {
  try {
    const { userId, token } = await request.json();

    if (!userId) {
      return NextResponse.json(
        { error: 'User ID is required' },
        { status: 400 }
      );
    }

    // Validate token to prevent unauthorized unsubscriptions
    if (!token || !verifyUnsubscribeToken(userId, token)) {
      return NextResponse.json(
        { error: 'Invalid or missing unsubscribe token' },
        { status: 403 }
      );
    }

    // Force casting to any to bypass the restrictive "never" inference on the Supabase client
    // which likely stems from a mismatch in generated types vs actual usage in this context.
    const supabase = createServiceRoleClient() as any;

    const { error } = await supabase
      .from('profiles')
      .update({ newsletter_subscribed: false })
      .eq('id', userId);

    if (error) {
      console.error('Error updating profile:', error);
      return NextResponse.json(
        { error: 'Failed to unsubscribe' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Unsubscribe error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
