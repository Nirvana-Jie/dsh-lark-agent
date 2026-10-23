import type {ReplyPayload} from './replies.js';

/** Delay cosmetic work for fast commands, then replace the one confirmed placeholder. */
export class CommandFeedback {
  private timer: ReturnType<typeof setTimeout>;
  private pending?: Promise<string>;
  private completion?: Promise<void>;

  constructor(private readonly create: () => Promise<string>,
    private readonly update: (messageId: string, payload: ReplyPayload) => Promise<void>, delayMs = 200) {
    this.timer = setTimeout(() => {
      // Also contain a transport that throws before returning its promise.
      this.pending = Promise.resolve().then(() => this.create());
      void this.pending.catch(() => undefined);
    }, delayMs);
  }

  finish(payload: ReplyPayload, fallback: () => Promise<void>): Promise<void> {
    if (this.completion) return this.completion;
    clearTimeout(this.timer);
    const pending = this.pending;
    // An uncertain create may already have delivered. Never send a second
    // message as a fallback, and never repeat the command to retry its UI.
    return this.completion = pending
      ? pending.then(messageId => this.update(messageId, payload))
      : Promise.resolve().then(fallback);
  }
}
