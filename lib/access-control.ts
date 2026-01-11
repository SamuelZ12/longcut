import type { User } from '@supabase/supabase-js';

const unlimitedVideoUsers = new Set(
  (process.env.UNLIMITED_VIDEO_USERS ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
);

export function hasUnlimitedVideoAllowance(user: User | null | undefined): boolean {
  if (!user) {
    return false;
  }

  if (unlimitedVideoUsers.size === 0) {
    return false;
  }

  const normalizedId = user.id.toLowerCase();
  if (unlimitedVideoUsers.has(normalizedId)) {
    return true;
  }

  const email = user.email?.toLowerCase();
  return email ? unlimitedVideoUsers.has(email) : false;
}

/**
 * Check unlimited access by user ID only (for background processes).
 * Note: This only checks user ID, not email. If you configured unlimited
 * users by email only, this won't match them.
 */
export function hasUnlimitedVideoAllowanceById(userId: string | null | undefined): boolean {
  if (!userId) {
    return false;
  }

  if (unlimitedVideoUsers.size === 0) {
    return false;
  }

  return unlimitedVideoUsers.has(userId.toLowerCase());
}
