import crypto from 'crypto';

const SECRET_KEY = process.env.CSRF_SALT || process.env.SUPABASE_SERVICE_ROLE_KEY || 'default-secret-key-change-me';

/**
 * Generates a signed token for unsubscribing a user.
 * The token is an HMAC-SHA256 of the userId.
 */
export function generateUnsubscribeToken(userId: string): string {
  if (!userId) throw new Error('userId is required');

  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(userId);
  return hmac.digest('hex');
}

/**
 * Verifies if the token is valid for the given userId.
 */
export function verifyUnsubscribeToken(userId: string, token: string): boolean {
  if (!userId || !token) return false;

  const expectedToken = generateUnsubscribeToken(userId);

  // Use constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(expectedToken)
    );
  } catch (e) {
    // Length mismatch or other error
    return false;
  }
}
