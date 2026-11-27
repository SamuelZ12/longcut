import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendEmail } from '@/lib/email/send';

const email = { to: 'user@example.com', subject: 'Welcome', html: '<p>Hi</p>' };

function stubResend(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('sendEmail', () => {
  it('sends from zara@longcut.ai and returns the Resend id', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    const fetchMock = stubResend(200, { id: 'email-1' });

    await expect(sendEmail(email)).resolves.toEqual({ id: 'email-1' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer re_test');
    expect(JSON.parse(init.body as string)).toEqual({ from: 'zara@longcut.ai', ...email });
  });

  it('throws with Resend\'s message when the send is rejected', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    stubResend(403, { message: 'The longcut.ai domain is not verified.' });

    await expect(sendEmail(email)).rejects.toThrow('Resend 403: The longcut.ai domain is not verified.');
  });

  it('throws without calling Resend when the key is missing', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const fetchMock = stubResend(200, { id: 'email-1' });

    await expect(sendEmail(email)).rejects.toThrow('RESEND_API_KEY is not set');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
