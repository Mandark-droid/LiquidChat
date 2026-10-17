/**
 * Memory proposals awaiting the user's decision (PRD §8.3: nothing becomes
 * permanent memory without consent). Kept in-process; dismissed on restart.
 */
import type { MemoryManager, MemoryProposal } from './MemoryManager';

export interface PendingProposal extends MemoryProposal {
  id: string;
  executionId?: string;
  createdAt: number;
}

type Listener = (items: PendingProposal[]) => void;

export class ProposalQueue {
  private items: PendingProposal[] = [];
  private listeners = new Set<Listener>();

  add(p: MemoryProposal, executionId?: string): void {
    if (this.items.some(i => i.content === p.content)) return;
    this.items.unshift({ ...p, executionId, id: `prop_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, createdAt: Date.now() });
    this.items = this.items.slice(0, 20);
    this.emit();
  }

  list(): PendingProposal[] {
    return [...this.items];
  }

  async accept(id: string, memory: MemoryManager): Promise<void> {
    const p = this.items.find(i => i.id === id);
    if (!p) return;
    await memory.create({ kind: p.kind, title: p.title, content: p.content, tags: p.tags, sensitive: p.sensitive, source: 'approved_proposal' });
    this.dismiss(id);
  }

  dismiss(id: string): void {
    this.items = this.items.filter(i => i.id !== id);
    this.emit();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.list());
    return () => {
      this.listeners.delete(l);
    };
  }

  private emit() {
    for (const l of this.listeners) l(this.list());
  }
}

export const memoryProposals = new ProposalQueue();
