import { createHash, randomBytes } from 'node:crypto';

/** SHA-256 of text or bytes, hex encoded. Used for stale-file detection. */
export function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Hash that stands for "this file does not exist". */
export const ABSENT_HASH = 'absent';

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}
