/**
 * Removes credentials from text before it is logged, stored, shown to the
 * user, or sent back to a provider as tool output.
 */

const MASK = '[REDACTED]';

/** Patterns for credentials whose exact value we do not know in advance. */
const GENERIC_PATTERNS: Array<[RegExp, string]> = [
  // Authorization headers in any casing, with or without a scheme.
  [/(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^\s"',;]+/gi, `$1${MASK}`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // key=value style assignments for names that look secret.
  [
    /\b((?:x-)?(?:api[_-]?key|apikey|secret|token|password|passwd|access[_-]?key|client[_-]?secret)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi,
    `$1${MASK}`,
  ],
  // Common vendor key shapes.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  // Credentials embedded in URLs: scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
];

export class Redactor {
  private readonly secrets = new Set<string>();

  /** Registers an exact value that must never appear in output. */
  addSecret(value: string | undefined | null): void {
    if (!value) return;
    const trimmed = value.trim();
    // Very short values would mask ordinary text.
    if (trimmed.length >= 6) this.secrets.add(trimmed);
  }

  removeSecret(value: string | undefined | null): void {
    if (value) this.secrets.delete(value.trim());
  }

  redact(text: string): string {
    if (!text) return text;
    let out = text;
    // Longest first so a secret that contains another is fully removed.
    const known = [...this.secrets].sort((a, b) => b.length - a.length);
    for (const secret of known) {
      if (out.includes(secret)) out = out.split(secret).join(MASK);
    }
    for (const [pattern, replacement] of GENERIC_PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    return out;
  }

  /** Redacts every string inside a JSON-like value. */
  redactValue<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = isSecretKey(k) && typeof v === 'string' ? MASK : this.redactValue(v);
      }
      return out as T;
    }
    return value;
  }
}

function isSecretKey(key: string): boolean {
  return /^(authorization|api[_-]?key|apikey|token|secret|password|client[_-]?secret)$/i.test(key);
}

export const REDACTED = MASK;
