/** Email ownership and agent registration helpers. Email is an account key,
 * never an authorization proof. Challenges are bound to one enrollment. */
import { DbClient, Env, HttpError, Row } from './types.js';
import { credentialHash, randomBase62, sha256hex } from './auth.js';
import { reqString, reqAgentPublicKey, reqEmail } from './validate.js';

export async function challengeBinding(
  env: Env,
  code: string,
  token: string,
  publicKey: string,
): Promise<string> {
  return sha256hex(
    JSON.stringify([
      await credentialHash(env.TOKEN_PEPPER, code),
      await credentialHash(env.TOKEN_PEPPER, token),
      publicKey,
    ]),
  );
}

export async function issueEmailChallenge(
  db: DbClient,
  env: Env,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const recovery = body['email'] !== undefined;
  const email = recovery ? reqEmail(body['email'], 'email') : null;
  const code = recovery
    ? 'recovery:' + email
    : reqString(body['enrollment_code'], 'enrollment_code', 1, 128);
  const token = reqString(body['agent_token'], 'agent_token', 46, 46);
  if (!/^fh_[A-Za-z0-9_-]{43}$/.test(token))
    throw new HttpError(400, 'bad_request', 'Invalid agent credential');
  const publicKey = reqAgentPublicKey(body['agent_public_key'], 'agent_public_key');
  const codeHash = await credentialHash(env.TOKEN_PEPPER, code);
  const recoveryUser = recovery
    ? await db.queryOne('SELECT id FROM principals WHERE email=?', [email])
    : null;
  const source = recovery
    ? { email }
    : code.startsWith('fhp_')
      ? await db.queryOne(
          `SELECT p.*, m.email FROM provisioning_codes p JOIN members m ON m.id=p.member_id WHERE p.code_hash=? AND m.removed_at IS NULL`,
          [codeHash],
        )
      : await db.queryOne('SELECT * FROM invites WHERE code_hash=?', [codeHash]);
  const now = new Date().toISOString();
  if (!source) throw new HttpError(404, 'not_found', 'Enrollment code not found');
  if (source['used_at'])
    throw new HttpError(409, 'enrollment_conflict', 'Enrollment code was already consumed');
  if (!recovery && String(source['expires_at']) <= now)
    throw new HttpError(
      410,
      code.startsWith('fhp_') ? 'code_expired' : 'invite_expired',
      'Enrollment code expired',
    );
  if (!recovery && code.startsWith('fhp_') && (await hasAgentApproval(db, codeHash))) {
    return {
      next_action: 'redeem_agent_approval',
      email_verification_required: false,
      expires_at: source['expires_at'],
    };
  }
  if (!env.EMAIL_DELIVERY && (!env.EMAIL_API_TOKEN || !env.EMAIL_FROM)) {
    throw new HttpError(
      503,
      'email_not_configured',
      'The server operator must configure email delivery before registration',
    );
  }
  await db.queryAll('DELETE FROM email_challenges WHERE expires_at<?', [
    new Date(Date.now() - 86400_000).toISOString(),
  ]);
  const emailBudget = await db.queryOne(
    'SELECT count(*) n FROM email_challenges WHERE email=? AND created_at>?',
    [source['email'] as string, new Date(Date.now() - 3600_000).toISOString()],
  );
  if (Number(emailBudget?.['n']) >= 5)
    throw new HttpError(
      429,
      'rate_limited',
      'Email verification request limit reached; retry later',
    );
  const binding = await challengeBinding(env, code, token, publicKey);
  const recent = await db.queryOne(
    'SELECT id FROM email_challenges WHERE binding_hash=? AND created_at>?',
    [binding, new Date(Date.now() - 60_000).toISOString()],
  );
  if (recent)
    throw new HttpError(429, 'rate_limited', 'Wait one minute before requesting another email');
  const id = crypto.randomUUID();
  const proof = randomBase62(32);
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  await db.execAtomically([
    {
      sql: `INSERT INTO email_challenges(id,binding_hash,email,proof_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)`,
      params: [
        id,
        binding,
        source['email'] as string,
        await credentialHash(env.TOKEN_PEPPER, proof),
        expires,
        now,
      ],
    },
  ]);
  try {
    if (recovery && !recoveryUser) {
      // Identical challenge state and throttling for unknown recovery emails.
      // No message is sent and no user is created.
    } else if (env.EMAIL_DELIVERY) await env.EMAIL_DELIVERY(source['email'] as string, proof, id);
    else {
      const result = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: 'Bearer ' + env.EMAIL_API_TOKEN,
          'Content-Type': 'application/json',
          'Idempotency-Key': id,
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: [source['email']],
          subject: 'Approve your Muse connector registration',
          text: `Only approve this if you are registering your own Muse agent. Do not share this code with another person.\n\nRegistration code: ${proof}\n\nExpires in 10 minutes.`,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!result.ok) throw new Error('delivery_failed');
    }
  } catch {
    await db.queryAll('DELETE FROM email_challenges WHERE id=?', [id]);
    throw new HttpError(
      503,
      'email_delivery_failed',
      'Verification email could not be delivered; retry later',
    );
  }
  return { challenge_id: id, expires_at: expires, next_action: 'provide_email_verification_code' };
}

export async function verifyEmailChallenge(
  db: DbClient,
  env: Env,
  body: Record<string, unknown>,
  code: string,
  email: string,
): Promise<Row> {
  const id = reqString(body['challenge_id'], 'challenge_id', 1, 128);
  const proof = reqString(body['verification_code'], 'verification_code', 1, 128);
  const row = await db.queryOne('SELECT * FROM email_challenges WHERE id=?', [id]);
  if (
    !row ||
    row['email'] !== email ||
    row['used_at'] ||
    String(row['expires_at']) <= new Date().toISOString() ||
    row['proof_hash'] !== (await credentialHash(env.TOKEN_PEPPER, proof)) ||
    row['binding_hash'] !==
      (await challengeBinding(
        env,
        code,
        String(body['agent_token']),
        String(body['agent_public_key']),
      ))
  ) {
    throw new HttpError(
      403,
      'email_verification_required',
      'Provide a valid email verification code for this enrollment',
    );
  }
  return row;
}

/** A private approval code minted by this user's authenticated agent is an
 * alternative to email proof for enrolling another agent. Never a circle
 * administrator's authority over somebody else's account. Alias p is fixed. */
export const AGENT_APPROVAL_PREDICATE = `EXISTS (
  SELECT 1 FROM agent_tokens issuer JOIN agents a ON a.id=issuer.agent_id
  JOIN members owner ON owner.id=p.member_id JOIN principals u ON u.id=owner.principal_id
  WHERE issuer.token_id=p.issued_by_token_id AND a.user_id=u.id
    AND a.revoked_at IS NULL AND owner.removed_at IS NULL AND u.email_verified_at IS NOT NULL
    AND (issuer.revoked_at IS NULL OR issuer.revoked_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`;

export async function hasAgentApproval(db: DbClient, codeHash: string): Promise<boolean> {
  return !!(await db.queryOne(
    `SELECT 1 FROM provisioning_codes p WHERE p.code_hash=?
    AND p.used_at IS NULL AND p.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND ${AGENT_APPROVAL_PREDICATE}`,
    [codeHash],
  ));
}
