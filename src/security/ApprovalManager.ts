/**
 * User approvals for sensitive actions and first-time cloud transmission
 * (PRD §7.3, §6.6). The runtime awaits a decision; the UI (ApprovalHost)
 * renders the queue. Approvals come only from the user interface — never from
 * model output, tool results or memory.
 */
export type ApprovalKind = 'tool' | 'remote_inference' | 'skill_activation' | 'memory_write';
export type ApprovalDecision = 'approve_once' | 'approve_always' | 'deny';

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  /** Whether "always allow" may be offered (never for sends / sensitive data classes). */
  allowAlways: boolean;
  executionId?: string;
  createdAt: number;
  /** Spoken prompt for voice sessions. */
  speak?: string;
}

type Listener = (queue: ApprovalRequest[]) => void;
type Handler = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export class ApprovalManager {
  private queue: { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void }[] = [];
  private listeners = new Set<Listener>();
  /** Non-UI contexts (evals, tests, scheduled runs) install a handler; default is the UI queue. */
  private handler: Handler | null = null;

  setHandler(h: Handler | null): void {
    this.handler = h;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.pending());
    return () => {
      this.listeners.delete(l);
    };
  }

  pending(): ApprovalRequest[] {
    return this.queue.map(q => q.req);
  }

  request(input: Omit<ApprovalRequest, 'id' | 'createdAt'>): Promise<ApprovalDecision> {
    const req: ApprovalRequest = {
      ...input,
      allowAlways: input.allowAlways && input.risk !== 'high',
      id: `apr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
    };
    if (this.handler) return this.handler(req);
    return new Promise(resolve => {
      this.queue.push({ req, resolve });
      this.emit();
    });
  }

  /** Called by the UI. Unknown ids are ignored. */
  respond(id: string, decision: ApprovalDecision): void {
    const i = this.queue.findIndex(q => q.req.id === id);
    if (i < 0) return;
    const [item] = this.queue.splice(i, 1);
    const allowed =
      decision === 'approve_always' && !item.req.allowAlways ? 'approve_once' : decision;
    item.resolve(allowed);
    this.emit();
  }

  /** Denies everything outstanding for an execution (used on cancel). */
  denyAllFor(executionId: string): void {
    for (const q of [...this.queue])
      if (q.req.executionId === executionId) this.respond(q.req.id, 'deny');
  }

  private emit() {
    const p = this.pending();
    for (const l of this.listeners) {
      try {
        l(p);
      } catch {}
    }
  }
}

export const approvals = new ApprovalManager();
