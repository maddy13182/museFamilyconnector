// PII scanner (SPEC §11). Runs server-side on every entry body and task
// note BEFORE insert. On a hit the request is REJECTED with 422 and an
// explanation — never silently stored.
// Zero runtime dependencies. The CLI (WS-2) reuses the same patterns.

export interface PiiHit {
  kind: 'card' | 'ssn' | 'custom';
  /** Redacted description safe to show the agent, e.g. "possible card number". */
  description: string;
}

export interface PiiConfig {
  /** Extra RegExp sources applied in addition to card + SSN. Deployment-configurable. */
  extraPatterns?: Array<{ name: string; source: string; flags?: string }>;
}

/** Luhn check for card-like digit runs. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// Candidate: 13-19 digits possibly separated by spaces/dashes, not part of a
// longer digit run. We then strip separators and require 13-19 digits + Luhn.
const CARD_CANDIDATE = /(?<!\d)(?:\d[ \-]?){13,19}(?!\d)/g;
// US SSN shape. Word-ish boundaries so we don't match inside longer numbers.
const SSN_PATTERN = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/;

/**
 * Scan text for PII. Returns the first hit, or null.
 * Never returns the matched value itself (callers must not log it either).
 */
export function scanPii(text: string, config: PiiConfig = {}): PiiHit | null {
  if (!text) return null;

  CARD_CANDIDATE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CARD_CANDIDATE.exec(text)) !== null) {
    const digits = m[0].replace(/[ \-]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      return { kind: 'card', description: 'possible card number detected' };
    }
    // Avoid infinite loop on zero-width edge cases (defensive).
    if (m[0].length === 0) CARD_CANDIDATE.lastIndex++;
  }

  if (SSN_PATTERN.test(text)) {
    return { kind: 'ssn', description: 'possible SSN detected (###-##-#### pattern)' };
  }

  for (const p of config.extraPatterns ?? []) {
    const re = new RegExp(p.source, p.flags ?? '');
    if (re.test(text)) {
      return { kind: 'custom', description: `matched sensitive pattern: ${p.name}` };
    }
  }
  return null;
}
