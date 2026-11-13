import { describe, expect, it } from 'vitest';
import { SseParser } from '../../src/providers/sse';

const enc = new TextEncoder();

function feed(parser: SseParser, parts: Array<string | Uint8Array>): string[] {
  const out: string[] = [];
  for (const p of parts) out.push(...parser.push(typeof p === 'string' ? enc.encode(p) : p));
  out.push(...parser.finish());
  return out;
}

describe('SseParser', () => {
  it('parses complete events', () => {
    expect(feed(new SseParser(), ['data: a\n\ndata: b\n\n'])).toEqual(['a', 'b']);
  });
  it('handles events split at arbitrary positions', () => {
    const text = 'data: {"x":1}\n\ndata: {"y":2}\n\ndata: [DONE]\n\n';
    for (let cut = 1; cut < text.length; cut++) {
      expect(feed(new SseParser(), [text.slice(0, cut), text.slice(cut)])).toEqual(['{"x":1}', '{"y":2}', '[DONE]']);
    }
  });
  it('handles CRLF and lone CR line endings, even when split', () => {
    expect(feed(new SseParser(), ['data: a\r\n\r\ndata: b\r\n\r\n'])).toEqual(['a', 'b']);
    expect(feed(new SseParser(), ['data: a\r', '\n\r', '\ndata: b\r\n\r\n'])).toEqual(['a', 'b']);
    expect(feed(new SseParser(), ['data: a\r\rdata: b\r\r'])).toEqual(['a', 'b']);
  });
  it('joins multi-line data and ignores comments and other fields', () => {
    expect(feed(new SseParser(), [': keep-alive\n\nevent: x\nid: 1\ndata: one\ndata: two\n\n'])).toEqual(['one\ntwo']);
  });
  it('accepts data without a space after the colon', () => {
    expect(feed(new SseParser(), ['data:{"a":1}\n\n'])).toEqual(['{"a":1}']);
  });
  it('does not break multi-byte characters split across chunks', () => {
    const bytes = enc.encode('data: héllo 世界 🚀\n\n');
    const out: string[] = [];
    const parser = new SseParser();
    for (const b of bytes) out.push(...parser.push(new Uint8Array([b])));
    out.push(...parser.finish());
    expect(out).toEqual(['héllo 世界 🚀']);
  });
  it('flushes a final event that has no trailing blank line', () => {
    expect(feed(new SseParser(), ['data: last'])).toEqual(['last']);
    expect(feed(new SseParser(), ['data: last\n'])).toEqual(['last']);
  });
  it('returns nothing for empty input', () => {
    expect(feed(new SseParser(), [])).toEqual([]);
    expect(feed(new SseParser(), ['\n\n\n'])).toEqual([]);
  });
});
