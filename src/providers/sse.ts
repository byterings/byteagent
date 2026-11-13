/**
 * Incremental parser for server-sent events. Bytes may arrive split at any
 * position, including inside a multi-byte character or a line ending.
 */
export class SseParser {
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';
  private dataLines: string[] = [];

  /** Feeds a chunk and returns the data payloads of every completed event. */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /** Call once at end of stream to flush an event that lacked a blank line. */
  finish(): string[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const events: string[] = [];
    let start = 0;
    for (;;) {
      const newline = this.findLineEnd(start, final);
      if (!newline) break;
      const line = this.buffer.slice(start, newline.index);
      start = newline.next;
      this.handleLine(line, events);
    }
    this.buffer = this.buffer.slice(start);
    if (final) {
      if (this.buffer.length > 0) {
        this.handleLine(this.buffer, events);
        this.buffer = '';
      }
      this.flush(events);
    }
    return events;
  }

  private findLineEnd(from: number, final: boolean): { index: number; next: number } | undefined {
    for (let i = from; i < this.buffer.length; i++) {
      const ch = this.buffer.charCodeAt(i);
      if (ch === 10) return { index: i, next: i + 1 };
      if (ch === 13) {
        // A lone CR at the very end may be the first half of CRLF.
        if (i + 1 >= this.buffer.length && !final) return undefined;
        return { index: i, next: this.buffer.charCodeAt(i + 1) === 10 ? i + 2 : i + 1 };
      }
    }
    return undefined;
  }

  private handleLine(line: string, events: string[]): void {
    if (line === '') {
      this.flush(events);
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
    // "event", "id" and "retry" fields are not needed for chat streams.
  }

  private flush(events: string[]): void {
    if (this.dataLines.length === 0) return;
    events.push(this.dataLines.join('\n'));
    this.dataLines = [];
  }
}
