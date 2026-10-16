import type { CancellationToken } from '../tools/types';

export class CancellationSource implements CancellationToken {
  private _cancelled = false;
  private listeners = new Set<() => void>();
  private abort = typeof AbortController !== 'undefined' ? new AbortController() : null;

  get cancelled(): boolean {
    return this._cancelled;
  }

  get signal(): AbortSignal | undefined {
    return this.abort?.signal;
  }

  onCancel(cb: () => void): () => void {
    if (this._cancelled) {
      cb();
      return () => {};
    }
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  cancel(): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this.abort?.abort();
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {}
    }
    this.listeners.clear();
  }
}
