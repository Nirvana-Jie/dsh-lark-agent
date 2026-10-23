import type {TurnStreamEvent} from './dsh-runtime.js';
import {cardMarkdown, markdownBlocks, plainLabel} from './replies.js';

export interface LiveCardTransport {
  createCardEntity(card: Record<string, unknown>): Promise<string>;
  replyCardEntity(messageId: string, cardId: string, options: {idempotencyKey: string; inThread: boolean}): Promise<void>;
  streamCardText(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  updateCardEntity(cardId: string, card: Record<string, unknown>, sequence: number): Promise<void>;
}

export interface LiveReplyOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  audit?: (stage: string) => void;
}

export interface LiveReplyFinal {
  phase: 'done' | 'stopped' | 'failed';
  /** Authoritative answer text; replaces whatever was streamed. */
  answer?: string;
  reasoning?: string;
  /** Trusted application text shown under the answer. */
  note?: string;
}

type Step = {kind: 'reasoning'; text: string}
  | {kind: 'tool'; callId: string; name: string; detail?: string; state: 'running' | 'done' | 'failed'};

// CardKit rejects cards over 30 KB, measured on the card JSON.
const CARD_BYTES = 28_000;
const LIVE_STEP_BYTES = 6_000;
const LIVE_ANSWER_BYTES = 20_000;
const FINAL_STEP_BYTES = 8_000;
const MAX_KEPT_CHARS = 40_000;
// One card entity accepts at most 10 operations per second.
const STREAM_INTERVAL_MS = 500;
const FULL_INTERVAL_MS = 2_000;
// Feishu turns streaming mode off 10 minutes after it was last turned on.
const REOPEN_AFTER_MS = 9 * 60_000;
const TRUNCATED = '回复超过了飞书卡片的长度上限，后面的内容没有显示。完整回复在电脑上的这段 Harness 会话里，也可以让我整理成文档。';
const grey = (markdown: string) => `<font color='grey'>${markdown}</font>`;
const bytes = (value: unknown) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const code = (value: string) => '`' + value.replace(/`/g, 'ˋ') + '`';

/** The longest prefix of text within maxBytes, never splitting a code point. */
function head(text: string, maxBytes: number): string {
  let size = 0, end = 0;
  for (const point of text) {
    size += Buffer.byteLength(point, 'utf8');
    if (size > maxBytes) break;
    end += point.length;
  }
  return text.slice(0, end);
}

/**
 * A suffix of text within maxBytes. The cut moves in coarse steps so that
 * successive updates mostly share a prefix, which keeps Feishu's typewriter
 * effect instead of redrawing the whole element.
 */
function tail(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  let size = 0, start = text.length;
  while (start > 0) {
    const pair = start >= 2 && (text.charCodeAt(start - 1) & 0xfc00) === 0xdc00 && (text.charCodeAt(start - 2) & 0xfc00) === 0xd800;
    const width = Buffer.byteLength(text.slice(start - (pair ? 2 : 1), start), 'utf8');
    if (size + width > maxBytes) break;
    size += width;
    start -= pair ? 2 : 1;
  }
  let cut = Math.ceil(start / 1_000) * 1_000;
  const newline = text.indexOf('\n', cut);
  if (newline >= 0 && newline - cut < 200) cut = newline + 1;
  if (cut < text.length && (text.charCodeAt(cut) & 0xfc00) === 0xdc00) cut++;
  return text.slice(Math.min(cut, text.length));
}

/**
 * One streaming reply card: the answer, with reasoning and tool steps in a
 * panel that stays folded unless the reader opens it. Only the initial reply
 * is a send; every later operation updates the same card entity and is safe
 * to supersede or repeat. A reply never continues in another message.
 */
export class LiveReply {
  private phase: 'thinking' | 'answering' | LiveReplyFinal['phase'] = 'thinking';
  private readonly steps: Step[] = [];
  private trimmed = false;
  private answer = '';
  private separator = false;
  private mark = {steps: 0, tail: -1, answer: 0};
  private tools = 0;
  private note?: string;
  private cardId?: string;
  private sequence = 0;
  private readonly sent = new Map<string, string>();
  private dirty = false;
  private layoutDirty = false;
  private degraded = false;
  private streamFailures = 0;
  private closed = false;
  private loop?: Promise<void>;
  private wake?: () => void;
  private streamingSince = 0;
  private readonly startedAt: number;
  private answeredAt?: number;
  private finishedAt?: number;

  constructor(private readonly transport: LiveCardTransport,
    private readonly target: {messageId: string; inThread: boolean; idempotencyKey: string},
    private readonly options: LiveReplyOptions = {}) {
    this.startedAt = this.now();
  }

  /** Send the card. False means nothing was sent, so the caller keeps its ordinary reply. */
  async open(): Promise<boolean> {
    try { this.cardId = await this.transport.createCardEntity(this.card()); }
    catch { this.audit('live-card-unavailable'); return false; }
    this.streamingSince = this.now();
    this.markSent();
    try { await this.transport.replyCardEntity(this.target.messageId, this.cardId, {idempotencyKey: this.target.idempotencyKey, inThread: this.target.inThread}); }
    // The reply may still have been delivered. Never send another message for this
    // turn; updating a card nobody received is harmless.
    catch { this.audit('live-card-delivery-unknown'); }
    if (this.dirty) this.schedule();
    return true;
  }

  push(event: TurnStreamEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case 'attempt': {
        const last = this.steps.at(-1);
        this.mark = {steps: this.steps.length, tail: last?.kind === 'reasoning' ? last.text.length : -1, answer: this.answer.length};
        this.separator = this.answer.length > 0;
        break;
      }
      case 'discard': {
        this.steps.length = Math.min(this.steps.length, this.mark.steps);
        const last = this.steps.at(-1);
        if (this.mark.tail >= 0 && last?.kind === 'reasoning') last.text = last.text.slice(0, this.mark.tail);
        this.answer = this.answer.slice(0, this.mark.answer);
        this.separator = this.answer.length > 0;
        break;
      }
      case 'reasoning': {
        const last = this.steps.at(-1);
        if (last?.kind === 'reasoning') last.text += event.text;
        else this.steps.push({kind: 'reasoning', text: event.text});
        this.trim();
        break;
      }
      case 'text':
        if (this.answer.length > 70_000) return;
        if (this.separator) { this.answer += '\n\n'; this.separator = false; }
        this.answer += event.text;
        // The folded panel's title switches from "thinking" to the time it took.
        if (this.phase === 'thinking') { this.phase = 'answering'; this.answeredAt = this.now(); this.layoutDirty = true; }
        break;
      case 'tool':
        if (this.steps.some(step => step.kind === 'tool' && step.callId === event.callId)) return;
        this.steps.push({kind: 'tool', callId: event.callId, name: event.name, ...(event.detail ? {detail: event.detail} : {}), state: 'running'});
        this.tools++;
        this.layoutDirty = true;
        this.trim();
        break;
      case 'tool-done': {
        const step = this.steps.find(item => item.kind === 'tool' && item.callId === event.callId);
        if (step?.kind !== 'tool') return;
        step.state = event.ok ? 'done' : 'failed';
        break;
      }
    }
    this.schedule();
  }

  /** Stop streaming and write the final card. True only when Feishu confirmed it. */
  async finish(final: LiveReplyFinal): Promise<boolean> {
    if (this.closed) return false;
    this.closed = true;
    this.wake?.();
    await this.loop;
    this.finishedAt = this.now();
    this.phase = final.phase;
    if (final.answer !== undefined) this.answer = final.answer;
    if (final.reasoning && !this.steps.some(step => step.kind === 'reasoning')) this.steps.unshift({kind: 'reasoning', text: final.reasoning});
    for (const step of this.steps) if (step.kind === 'tool' && step.state === 'running') step.state = final.phase === 'done' ? 'done' : 'failed';
    this.note = final.note;
    const card = this.finalCard();
    if (!this.cardId) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.transport.updateCardEntity(this.cardId, card, ++this.sequence);
        return true;
      } catch {
        if (attempt < 2) await this.sleep(500 * 3 ** attempt);
      }
    }
    this.audit('live-card-final-failed');
    return false;
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private sleep(ms: number): Promise<void> { return (this.options.sleep ?? (wait => new Promise(done => setTimeout(done, wait))))(ms); }
  private audit(stage: string): void { try { this.options.audit?.(stage); } catch { /* Diagnostics only. */ } }

  /** Keep only what the card can still show; the turn result stays authoritative. */
  private trim(): void {
    let total = this.steps.reduce((sum, step) => sum + (step.kind === 'reasoning' ? step.text.length : 200), 0);
    while (total > MAX_KEPT_CHARS && this.steps.length > 1) {
      const removed = this.steps.shift()!;
      total -= removed.kind === 'reasoning' ? removed.text.length : 200;
      this.mark.steps = Math.max(0, this.mark.steps - 1);
      this.trimmed = true;
    }
    const only = this.steps[0];
    if (this.steps.length === 1 && only?.kind === 'reasoning' && only.text.length > MAX_KEPT_CHARS) {
      const cut = only.text.length - MAX_KEPT_CHARS / 2;
      only.text = only.text.slice(cut);
      this.mark.tail = Math.max(-1, this.mark.tail - cut);
      this.trimmed = true;
    }
  }

  private schedule(): void {
    this.dirty = true;
    if (!this.cardId || this.closed || this.loop) return;
    this.loop = this.run().finally(() => {
      this.loop = undefined;
      if (this.dirty && !this.closed) this.schedule();
    });
  }

  private async run(): Promise<void> {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      const started = this.now();
      await this.flush();
      const wait = (this.degraded ? FULL_INTERVAL_MS : STREAM_INTERVAL_MS) - (this.now() - started);
      if (wait > 0 && !this.closed) await this.pause(wait);
    }
  }

  /** Pacing between updates; finishing the reply ends it early. */
  private async pause(ms: number): Promise<void> {
    await Promise.race([this.sleep(ms), new Promise<void>(done => { this.wake = done; })]);
    this.wake = undefined;
  }

  private async flush(): Promise<void> {
    const cardId = this.cardId!;
    if (this.degraded || this.layoutDirty || this.now() - this.streamingSince > REOPEN_AFTER_MS) {
      this.layoutDirty = false;
      try {
        // A complete card also turns streaming mode back on.
        await this.transport.updateCardEntity(cardId, this.card(), ++this.sequence);
        this.streamingSince = this.now();
        this.markSent();
        this.degraded = this.streamFailures >= 3;
      } catch { this.degraded = true; }
      return;
    }
    for (const [id, content] of [['think', this.thinkContent()], ['answer', this.answerContent()]] as const) {
      if (this.closed) return;
      if (this.sent.get(id) === content) continue;
      try {
        await this.transport.streamCardText(cardId, id, content, ++this.sequence);
        this.sent.set(id, content);
      } catch {
        this.streamFailures++;
        this.degraded = true;
        this.audit('live-card-degraded');
        return;
      }
    }
  }

  private markSent(): void {
    this.sent.set('think', this.thinkContent());
    this.sent.set('answer', this.answerContent());
  }

  private stepsMarkdown(maxBytes: number): string {
    const parts = this.steps.map(step => step.kind === 'reasoning' ? cardMarkdown(step.text.trim())
      : `${step.state === 'running' ? '⏳' : step.state === 'done' ? '✅' : '⚠️'} ${code(step.name)}${step.detail ? ' ' + code(step.detail) : ''}`)
      .filter(Boolean);
    const text = parts.join('\n\n');
    const shown = tail(text, maxBytes);
    return (this.trimmed || shown.length < text.length) && shown ? `${grey('…')}\n${shown}` : shown;
  }

  private thinkContent(): string {
    return this.stepsMarkdown(LIVE_STEP_BYTES) || grey('正在思考…');
  }

  private answerContent(): string {
    if (!this.answer) return grey('…');
    const shown = head(this.answer, LIVE_ANSWER_BYTES);
    return cardMarkdown(shown) + (shown.length < this.answer.length ? `\n\n${grey('……')}` : '');
  }

  private panelTitle(): string {
    const tools = this.tools ? ` · 使用工具 ${this.tools} 次` : '';
    if (this.phase === 'thinking') return `💭 思考中…${tools}`;
    const seconds = Math.max(1, Math.round(((this.answeredAt ?? this.finishedAt ?? this.now()) - this.startedAt) / 1000));
    return `💭 思考了 ${seconds} 秒${tools}`;
  }

  /** The folded process panel. Readers open it when they want the reasoning and tool steps. */
  private panel(content: string): Record<string, unknown> {
    return {
      tag: 'collapsible_panel', element_id: 'think_panel', expanded: false,
      header: {title: {tag: 'markdown', content: this.panelTitle()}, vertical_align: 'center',
        icon: {tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px'}, icon_position: 'follow_text', icon_expanded_angle: -180},
      border: {color: 'grey', corner_radius: '5px'}, vertical_spacing: '8px', padding: '8px 8px 8px 8px',
      elements: [{tag: 'markdown', element_id: 'think', content, text_size: 'notation'}],
    };
  }

  /** Live layout when steps is undefined; a final layout otherwise ('' leaves out the panel). */
  private card(final?: {answer: string; steps: string; truncated: boolean}): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [];
    if (!final) elements.push(this.panel(this.thinkContent()));
    else if (final.steps) elements.push(this.panel(final.steps));
    elements.push({tag: 'markdown', element_id: 'answer',
      content: final ? (final.answer.trim() ? cardMarkdown(final.answer) : grey('（没有文字回复）')) : this.answerContent()});
    const note = [this.note, final?.truncated ? TRUNCATED : undefined].filter(Boolean).join(' ');
    if (final && note) elements.push({tag: 'markdown', element_id: 'note', content: grey(cardMarkdown(note)), text_size: 'notation'});
    const summary = final ? plainLabel(final.answer || this.note || '回复', 60) || '回复' : this.answer ? '正在回复…' : '正在思考…';
    return {
      schema: '2.0',
      config: {update_multi: true, enable_forward: false, width_mode: 'default', summary: {content: summary}, streaming_mode: !final,
        ...(final ? {} : {streaming_config: {print_frequency_ms: {default: 30}, print_step: {default: 2}, print_strategy: 'fast'}})},
      body: {direction: 'vertical', vertical_spacing: '8px', padding: '12px 16px 12px 16px', elements},
    };
  }

  /** The answer comes first. The folded process only gets the space that is left. */
  private finalCard(): Record<string, unknown> {
    // Reserve room for the folded title, so its time and tool count stay visible even beside a long answer.
    const minimal = this.steps.length ? grey('思考过程较长，卡片里没有显示。') : '';
    let answer = this.answer, truncated = false;
    const fits = (candidate: string, steps: string) => bytes(this.card({answer: candidate, steps, truncated})) <= CARD_BYTES;
    if (!fits(answer, minimal)) {
      truncated = true;
      // Cut between top-level blocks so what is shown stays valid Markdown.
      const blocks = markdownBlocks(this.answer);
      let low = 1, high = blocks.length - 1, best = 0;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (fits(blocks.slice(0, middle).join(''), minimal)) { best = middle; low = middle + 1; }
        else high = middle - 1;
      }
      if (best > 0) answer = blocks.slice(0, best).join('');
      else {
        // One oversized block, such as a long code listing: cut it by size.
        let budget = 20_000;
        answer = head(this.answer, budget);
        while (answer && !fits(answer, minimal)) answer = head(this.answer, budget = Math.floor(budget * 0.7));
      }
    }
    if (minimal) {
      let budget = Math.min(FINAL_STEP_BYTES, CARD_BYTES - bytes(this.card({answer, steps: '', truncated})) - 800);
      while (budget > 300) {
        const steps = this.stepsMarkdown(budget);
        if (steps && fits(answer, steps)) return this.card({answer, steps, truncated});
        budget = Math.floor(budget * 0.7);
      }
    }
    return this.card({answer, steps: minimal, truncated});
  }
}
