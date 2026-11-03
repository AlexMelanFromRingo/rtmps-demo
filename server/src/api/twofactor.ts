// Second factor verification shared by login and sensitive account actions.
import { one } from '../lib/db.ts';
import { open } from '../lib/secretbox.ts';
import { hashRecoveryCode, verifyTotp } from '../lib/totp.ts';

export const TOTP_PURPOSE = 'totp';

/**
 * Accepts a 6-digit TOTP code (each time step usable once — replay protection)
 * or a single-use recovery code. Returns true when the factor is valid.
 */
export async function verifySecondFactor(userId: string, code: string): Promise<boolean> {
  const u = await one<{ totp_secret_enc: string | null; totp_last_step: string | null }>(
    'SELECT totp_secret_enc, totp_last_step FROM users WHERE id = $1', [userId]);
  if (!u?.totp_secret_enc) return false;
  const trimmed = code.trim().replace(/\s/g, '');

  if (/^\d{6}$/.test(trimmed)) {
    const step = verifyTotp(open(u.totp_secret_enc, TOTP_PURPOSE), trimmed);
    if (step === null) return false;
    // Atomically consume the step: a code seen once can't be replayed.
    const consumed = await one(`UPDATE users SET totp_last_step = $2
                                 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id`, [userId, step]);
    return consumed !== null;
  }

  const used = await one(`UPDATE users SET recovery_codes = array_remove(recovery_codes, $2)
                           WHERE id = $1 AND $2 = ANY(recovery_codes) RETURNING id`, [userId, hashRecoveryCode(trimmed)]);
  return used !== null;
}
