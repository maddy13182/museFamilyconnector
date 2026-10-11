// Strict input validation for every endpoint (SPEC §7, §12).
// Every helper throws HttpError(400, 'bad_request', ...) on invalid input.
// Zero runtime dependencies.

import { HttpError } from './types.js';

export function reqString(v: unknown, name: string, min: number, max: number): string {
  if (typeof v !== 'string' || v.length < min || v.length > max) {
    throw new HttpError(400, 'bad_request', `${name} must be a string of ${min}-${max} chars`);
  }
  return v;
}

export function optString(v: unknown, name: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) {
    throw new HttpError(400, 'bad_request', `${name} must be a string of at most ${max} chars`);
  }
  return v;
}

export function reqEmail(v: unknown, name = 'email'): string {
  const s = reqString(v, name, 3, 254);
  // Pragmatic syntax check (not RFC-complete on purpose).
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    throw new HttpError(400, 'bad_request', `${name} is not a valid email address`);
  }
  return s.toLowerCase();
}

export function reqEnum<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new HttpError(
      400,
      'bad_request',
      `${name} must be one of: ${allowed.join(', ')}`,
    );
  }
  return v as T;
}

/** Array of non-empty string ids, deduplicated, length-bounded. */
export function reqIdArray(v: unknown, name: string, maxItems: number, minItems = 1): string[] {
  if (!Array.isArray(v) || v.length < minItems || v.length > maxItems) {
    throw new HttpError(
      400,
      'bad_request',
      `${name} must be an array of ${minItems}-${maxItems} ids`,
    );
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 128) {
      throw new HttpError(400, 'bad_request', `${name} must contain only non-empty string ids`);
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

export function parseLimit(v: string | null, def: number, max: number): number {
  if (v === null || v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new HttpError(400, 'bad_request', `limit must be an integer 1-${max}`);
  }
  return n;
}

export function parseSeqCursor(v: string | null): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(400, 'bad_request', 'cursor must be a non-negative integer');
  }
  return n;
}

export function reqIsoDate(v: unknown, name: string): string {
  const s = reqString(v, name, 10, 40);
  const t = Date.parse(s);
  if (Number.isNaN(t)) {
    throw new HttpError(400, 'bad_request', `${name} must be an ISO-8601 date string`);
  }
  return new Date(t).toISOString();
}

/** data payload: must be JSON-serializable, returned as canonical string. */
export function reqJsonData(v: unknown, name: string, maxChars: number): string | null {
  if (v === undefined || v === null) return null;
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    throw new HttpError(400, 'bad_request', `${name} must be JSON-serializable`);
  }
  if (s.length > maxChars) {
    throw new HttpError(400, 'bad_request', `${name} exceeds ${maxChars} chars`);
  }
  return s;
}

export function optSearchQuery(v: string | null): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v.length > 200) throw new HttpError(400, 'bad_request', 'q must be at most 200 chars');
  return v;
}

/** Escape LIKE wildcards for subject search. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// E2EE (Phase 1): an X25519 public key as strict standard-base64. Must
// decode to exactly 32 bytes. Strict on purpose: canonical base64 with
// padding only — unpadded or URL-safe alphabets are rejected so the same
// key can never be stored in two textual forms.
const AGENT_PUBKEY_B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function reqAgentPublicKey(v: unknown, name: string): string {
  if (typeof v !== 'string') {
    throw new HttpError(400, 'bad_request', `${name} must be a base64 string`);
  }
  const s = v.trim();
  if (s.length === 0 || s.length > 64 || s.length % 4 !== 0 || !AGENT_PUBKEY_B64_RE.test(s)) {
    throw new HttpError(
      400,
      'bad_request',
      `${name} must be standard base64 (with padding) decoding to exactly 32 bytes`,
    );
  }
  // atob() is available in both the Worker runtime and Node; each output
  // char is one byte, so .length is the decoded byte count. The strict
  // regex above already ruled out whitespace/non-alphabet input.
  let byteLen: number;
  try {
    byteLen = atob(s).length;
  } catch {
    throw new HttpError(400, 'bad_request', `${name} is not valid base64`);
  }
  if (byteLen !== 32) {
    throw new HttpError(
      400,
      'bad_request',
      `${name} must decode to exactly 32 bytes (X25519 public key); got ${byteLen}`,
    );
  }
  return s;
}

/** Optional variant: undefined/null = absent (no E2EE identity). */
export function optAgentPublicKey(v: unknown, name: string): string | null {
  if (v === undefined || v === null) return null;
  return reqAgentPublicKey(v, name);
}

// E2EE (Phase 2): the per-topic encryption flag. Optional in the request
// body; absent/null = 0 (plaintext, today's behavior). When present it must
// be the integer 0 or 1 — booleans and strings are rejected so the flag
// can never arrive in two textual forms.
export function reqE2eeFlag(v: unknown, name: string): number {
  if (v === undefined || v === null) return 0;
  if (v !== 0 && v !== 1) {
    throw new HttpError(400, 'bad_request', `${name} must be 0 or 1`);
  }
  return v;
}

// E2EE (Phase 2): a topic-key id — the random 128-bit value the CLI
// generates at topic creation, hex-encoded (32 hex chars). Normalized to
// lowercase for canonical storage/lookup.
const KEY_ID_HEX_RE = /^[0-9a-fA-F]{32}$/;

export function reqKeyId(v: unknown, name: string): string {
  if (typeof v !== 'string' || !KEY_ID_HEX_RE.test(v)) {
    throw new HttpError(400, 'bad_request', `${name} must be 32 hex chars (a random 128-bit id)`);
  }
  return v.toLowerCase();
}

// E2EE (Phase 2): a sealed key envelope — standard base64, opaque to the
// server (stored, never inspected). Format-validated only: the strict
// alphabet/padding rules keep one canonical textual form, and the length
// cap bounds the blob store. crypto_box_seal of the 48-byte
// (key_id || topic_key) plaintext is 96 bytes → 128 base64 chars.
const ENVELOPE_B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const ENVELOPE_B64_MAX = 4096;

export function reqEnvelopeB64(v: unknown, name: string): string {
  if (typeof v !== 'string') {
    throw new HttpError(400, 'bad_request', `${name} must be a base64 string`);
  }
  const s = v.trim();
  if (s.length === 0 || s.length > ENVELOPE_B64_MAX || s.length % 4 !== 0 || !ENVELOPE_B64_RE.test(s)) {
    throw new HttpError(
      400,
      'bad_request',
      `${name} must be standard base64 (with padding), at most ${ENVELOPE_B64_MAX} chars`,
    );
  }
  return s;
}
