import type { AgentEvents } from '../../src/agent/host';
import type { ChatItem, ChatItemPatch, UsageView } from '../../src/shared/protocol';

/** Records everything the runtime reports, as the chat UI would show it. */
export class RecordingEvents implements AgentEvents {
  items: ChatItem[] = [];
  usages: UsageView[] = [];
  deltas = 0;
  onAdd: ((item: ChatItem) => void) | undefined;
  onDelta: ((id: string, delta: string) => void) | undefined;

  add(item: ChatItem): void {
    this.items.push(item);
    this.onAdd?.(item);
  }
  update(id: string, patch: ChatItemPatch): void {
    this.items = this.items.map((item) => (item.id === id ? ({ ...item, ...patch } as ChatItem) : item));
  }
  appendText(id: string, delta: string): void {
    this.deltas += 1;
    this.items = this.items.map((item) => (item.id === id && item.kind === 'assistant' ? { ...item, text: item.text + delta } : item));
    this.onDelta?.(id, delta);
  }
  usage(usage: UsageView): void {
    this.usages.push(usage);
  }

  of<K extends ChatItem['kind']>(kind: K): Array<Extract<ChatItem, { kind: K }>> {
    return this.items.filter((i): i is Extract<ChatItem, { kind: K }> => i.kind === kind);
  }
  get assistantText(): string {
    return this.of('assistant').map((a) => a.text).join('\n');
  }
  get kinds(): string[] {
    return this.items.map((i) => i.kind);
  }
}
