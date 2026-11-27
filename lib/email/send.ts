const FROM = 'zara@longcut.ai';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail({ to, subject, html }: OutgoingEmail): Promise<{ id: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not set');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
    // The welcome email queue gives this route 30 seconds.
    signal: AbortSignal.timeout(20_000),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Resend ${response.status}: ${body?.message ?? response.statusText}`);
  }
  return { id: body.id };
}
