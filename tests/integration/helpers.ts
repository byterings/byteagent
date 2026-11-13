import type { AgentEvents, AgentHost } from '../../src/agent/host';
import { NodeChangeIO } from '../../src/changes/applier';
import type { ChangeIO, ChangeSet, ReviewDecision } from '../../src/changes/types';
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

export const acceptAll = (set: ChangeSet): ReviewDecision => ({
  decisions: Object.fromEntries(set.changes.map((c) => [c.id, 'accept' as const])),
});
export const rejectAll = (set: ChangeSet): ReviewDecision => ({
  decisions: Object.fromEntries(set.changes.map((c) => [c.id, 'reject' as const])),
});

/** Stands in for the user: answers reviews and confirmations from a script. */
export class FakeHost implements AgentHost {
  /** Every change set that was shown for review, in order. */
  reviews: ChangeSet[] = [];
  /** Decides each review. Defaults to rejecting, so a test must opt in to applying. */
  reviewer: (set: ChangeSet, count: number) => ReviewDecision | Promise<ReviewDecision> = rejectAll;
  confirm = true;
  changeIO: ChangeIO;

  constructor(root: string) {
    this.changeIO = new NodeChangeIO(root);
  }

  async confirmContext(): Promise<boolean> {
    return this.confirm;
  }

  async reviewChanges(set: ChangeSet, signal: AbortSignal): Promise<ReviewDecision> {
    this.reviews.push(set);
    if (signal.aborted) return { decisions: {} };
    return this.reviewer(set, this.reviews.length);
  }
}
