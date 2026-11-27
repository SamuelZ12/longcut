import * as dotenv from 'dotenv';
import { sendEmail } from '../lib/email/send';
import { getHtmlBody, getSubject } from '../lib/email/templates/monthly-update';

// Load environment variables from .env.local
dotenv.config({ path: '.env.local' });

const NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://longcut.ai';

async function sendTestNewsletter() {
  console.log('Sending test newsletter...');

  const testEmail = 'zhangsamuel12@gmail.com';
  const testUserId = 'test-user-id'; // Dummy ID for unsubscribe link

  const unsubscribeUrl = `${NEXT_PUBLIC_APP_URL}/unsubscribe?uid=${testUserId}`;
  const htmlBody = getHtmlBody(unsubscribeUrl);
  const subject = getSubject();

  try {
    const result = await sendEmail({ to: testEmail, subject, html: htmlBody });
    console.log(`✓ Test email sent successfully to ${testEmail}`);
    console.log(`Message ID: ${result.id}`);
  } catch (e: any) {
    console.error(`✗ Failed to send test email: ${e.message}`);
    process.exit(1);
  }
}

sendTestNewsletter().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
