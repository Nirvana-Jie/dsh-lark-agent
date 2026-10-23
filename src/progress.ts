export interface ProgressTransport {
  startProgress(messageId: string): Promise<string>;
  finishProgress(messageId: string, reactionId: string): Promise<void>;
}

interface Entry {
  messageId: string;
  references: number;
  worker?: Promise<void>;
  wake?: () => void;
}

/** Best-effort activity indicators; neither their creation nor cleanup delays a reply. */
export class ProgressTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly workers = new Set<Promise<void>>();
  private stopped = false;
  private draining?: Promise<void>;

  constructor(private readonly transport: ProgressTransport | undefined, private readonly onError: () => void = () => {}) {}

  begin(messageId: string): () => void {
    if (this.stopped || !this.transport) return () => {};
    let entry = this.entries.get(messageId);
    if (!entry) {
      entry = {messageId, references: 0};
      this.entries.set(messageId, entry);
    }
    entry.references++;
    if (!entry.worker) this.launch(entry);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      // drain() already clears every reference; late caller cleanup is harmless.
      entry.references = Math.max(0, entry.references - 1);
      const wake = entry.wake;
      entry.wake = undefined;
      wake?.();
    };
  }

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.stopped = true;
    for (const entry of this.entries.values()) {
      entry.references = 0;
      const wake = entry.wake;
      entry.wake = undefined;
      wake?.();
    }
    // Transport operations own their deadlines. Do not abandon an add that may
    // still succeed: the worker must observe its id and remove it afterwards.
    this.draining = Promise.allSettled([...this.workers]).then(() => undefined);
    return this.draining;
  }

  private report(): void {
    // Diagnostics themselves must not turn a cosmetic failure into an unhandled
    // rejection or prevent cleanup of a reaction that was already created.
    try { this.onError(); } catch { /* Best effort diagnostic. */ }
  }

  private async waitForCompletion(entry: Entry): Promise<void> {
    while (entry.references > 0) await new Promise<void>(resolve => { entry.wake = resolve; });
  }

  private launch(entry: Entry): void {
    const worker = this.reconcile(entry);
    entry.worker = worker;
    this.workers.add(worker);
    const settled = () => {
      this.workers.delete(worker);
      if (entry.worker !== worker) return;
      entry.worker = undefined;
      // A begin can arrive after reconcile's last reference check but before
      // this continuation. Start another generation only after deletion ended.
      if (entry.references > 0 && !this.stopped) this.launch(entry);
      else if (this.entries.get(entry.messageId) === entry) this.entries.delete(entry.messageId);
    };
    void worker.then(settled, () => { this.report(); settled(); });
  }

  private async reconcile(entry: Entry): Promise<void> {
    while (entry.references > 0) {
      let reactionId: string;
      try { reactionId = await this.transport!.startProgress(entry.messageId); }
      catch {
        this.report();
        // One failed attempt covers the whole current group of operations.
        // Retrying merely because refs remain nonzero would create a busy loop.
        await this.waitForCompletion(entry);
        return;
      }
      // Recheck after the awaited helper settles: a begin may run between the
      // helper observing zero references and this continuation resuming.
      do { await this.waitForCompletion(entry); } while (entry.references > 0);
      try { await this.transport!.finishProgress(entry.messageId, reactionId); }
      catch { this.report(); }
      // A new operation arriving during deletion is held here until that exact
      // old reaction has finished deletion before another add can start.
    }
  }
}
