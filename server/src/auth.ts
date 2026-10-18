// Agent authentication and live circle membership authorization.
// Zero runtime dependencies. Uses only global crypto (WebCrypto), available
// in both Cloudflare Workers and Node 18+.

import { DbClient, Env, HttpError, AuthContext } from './types.js';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function nowIso(): string {
  return new Date().toISOString();
}

/** sha256 hex of a string. Pepper is prepended by callers. */
export async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Cryptographically random base62 string of n characters. */
export function randomBase62(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let out = '';
  for (const b of bytes) out += BASE62[b % 62];
  return out;
}

/** Invite code: 'fhi_' + 128 bits. Meant to be shared with the invitee. */
export function newInviteCode(): string {
  return 'fhi_' + randomBase62(22);
}

/** Invite onboarding page token: 'fhip_' + 256 bits of entropy. The page URL
 *  is the credential — unguessable, single-use; only
 *  sha256(pepper || token) is ever stored. Returned to the inviter ONCE
 *  inside the invite's `onboarding_url`; never again. */
export function newInvitePageToken(): string {
  return 'fhip_' + randomBase62(43);
}

/** Provisioning code: 'fhp_' + 128 bits. Single-use, short-lived. */
export function newProvisioningCode(): string {
  return 'fhp_' + randomBase62(22);
}

/** Hash a raw credential for storage: sha256(TOKEN_PEPPER || value). */
export async function credentialHash(pepper: string, value: string): Promise<string> {
  return sha256hex(pepper + value);
}

/** Authenticate a credential and resolve its registered agent and user.
 * The token's member reference records registration origin, not permission.
 * circleContext independently validates the selected active membership.
 * A future revoked_at supports an explicitly scheduled credential expiry.
 */
export async function resolveToken(
  db: DbClient,
  env: Env,
  authHeader: string | null,
): Promise<AuthContext> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HttpError(401, 'unauthorized', 'Missing or malformed Authorization header');
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (token.length < 16 || token.length > 128) {
    throw new HttpError(401, 'unauthorized', 'Invalid token');
  }
  const hash = await credentialHash(env.TOKEN_PEPPER, token);
  const row = await db.queryOne(
    `SELECT t.token_id, t.member_id, a.label AS agent_label, a.id AS agent_id,
            t.revoked_at, a.user_id AS principal_id,
            m.family_id, m.role
       FROM agent_tokens t
       JOIN agents a ON a.id = t.agent_id
       JOIN members m ON m.id = t.member_id
      WHERE t.token_hash = ?`,
    [hash],
  );
  if (!row) {
    throw new HttpError(401, 'unauthorized', 'Unknown token');
  }
  const revokedAt = row['revoked_at'] as string | null;
  if (revokedAt && revokedAt <= nowIso()) {
    throw new HttpError(401, 'unauthorized', 'Token revoked');
  }
  // Best-effort last-used tracking (metadata only, never the token itself).
  try {
    await db.queryAll(`UPDATE agent_tokens SET last_used_at = ? WHERE token_hash = ?`, [
      nowIso(),
      hash,
    ]);
  } catch {
    /* non-fatal */
  }
  return {
    agent_id: row['agent_id'] as string,
    family_id: row['family_id'] as string,
    member_id: row['member_id'] as string,
    role: row['role'] as AuthContext['role'],
    token_id: row['token_id'] as string,
    agent_label: row['agent_label'] as string,
    principal_id: row['principal_id'] as string | null,
  };
}

/** Select a membership independently of the agent's registration circle. */
export async function circleContext(
  db: DbClient,
  auth: AuthContext,
  circleId: string,
): Promise<AuthContext> {
  const member = await db.queryOne(
    'SELECT id, family_id, role FROM members WHERE principal_id = ? AND family_id = ? AND removed_at IS NULL',
    [auth.principal_id, circleId],
  );
  if (!member)
    throw new HttpError(
      403,
      'not_a_member',
      'This user is not an active member of the requested circle',
    );
  return {
    ...auth,
    member_id: member['id'] as string,
    family_id: member['family_id'] as string,
    role: member['role'] as AuthContext['role'],
  };
}
