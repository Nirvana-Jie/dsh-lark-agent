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

type Step = {id: number; kind: 'reasoning'; text: string}
  | {id: number; kind: 'tool'; callId: string; name: string; detail?: string; code?: boolean; state: 'running' | 'done' | 'failed'; exitCode?: number};

// CardKit rejects cards over 30 KB, measured on the card JSON.
const CARD_BYTES = 28_000;
const LIVE_ANSWER_BYTES = 20_000;
const MAX_KEPT_CHARS = 40_000;
// Cards have a component limit; older steps fold into one note beyond this.
const MAX_ROWS = 60;
// One card entity accepts at most 10 operations per second.
const STREAM_INTERVAL_MS = 500;
const FULL_INTERVAL_MS = 2_000;
// Feishu turns streaming mode off 10 minutes after it was last turned on.
const REOPEN_AFTER_MS = 9 * 60_000;
const TRUNCATED = '回复超过了飞书卡片的长度上限，后面的内容没有显示。完整回复在电脑上的这段 Harness 会话里，也可以让我整理成文档。';
const grey = (markdown: string) => `<font color='grey'>${markdown}</font>`;
const bytes = (value: unknown) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const code = (value: string) => '`' + value.replace(/`/g, 'ˋ') + '`';
// A harness turn may run for an hour; past a minute, seconds stop being readable.
const elapsed = (seconds: number) => seconds < 60 ? `${seconds} 秒`
  : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;

/** The App's step labels and a matching Feishu icon, by tool name. */
function activity(name: string): {label: string; doing: string; icon: string} {
  const is = (...names: string[]) => names.includes(name);
  if (is('read')) return {label: '读取', doing: '正在读取文件', icon: 'file-link-text_outlined'};
  if (is('read_image')) return {label: '读取图片', doing: '正在读取图片', icon: 'image_outlined'};
  if (is('grep')) return {label: '搜索文件内容', doing: '正在搜索代码', icon: 'doc-search_outlined'};
  if (is('glob') || name.endsWith('_inspect')) return {label: '查找文件', doing: '正在搜索代码', icon: 'search_outlined'};
  if (is('write')) return {label: '写入', doing: '正在写入文件', icon: 'add-doc_outlined'};
  if (is('edit', 'apply_patch')) return {label: '编辑', doing: '正在编辑文件', icon: 'edit_outlined'};
  if (is('bash', 'pwsh', 'exec_command', 'write_stdin') || name.startsWith('terminal_')) return {label: '运行命令', doing: '正在运行命令', icon: 'code_outlined'};
  if (is('run_code')) return {label: '运行代码', doing: '正在运行代码', icon: 'codeblock_outlined'};
  if (is('web_search')) return {label: '网页搜索', doing: '正在搜索网页', icon: 'internet_outlined'};
  if (is('web_fetch')) return {label: '网页获取', doing: '正在访问网页', icon: 'web-card_outlined'};
  if (is('subagent') || name.startsWith('subagent_')) return {label: '子智能体', doing: '正在协调子智能体', icon: 'robot_outlined'};
  if (is('todo_write', 'create_goal', 'update_goal', 'get_goal')) return {label: '更新计划', doing: '正在更新计划', icon: 'list-check_outlined'};
  if (is('ask_user_question', 'request_user_input')) return {label: '提问', doing: '等待你的操作', icon: 'chat_outlined'};
  if (name.startsWith('lark_memory_')) return {label: '记忆', doing: '正在查看记忆', icon: 'mindnote_outlined'};
  if (is('lark_present')) return {label: '整理作品', doing: '正在整理作品', icon: 'web-card_outlined'};
  return {label: plainLabel(name, 40) || '工具调用', doing: '正在调用工具', icon: 'setting_outlined'};
}

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
 * One streaming reply card: the answer, with the process in a panel that
 * stays folded unless the reader opens it. Like the App, the process is a
 * list of steps, thinking and tool calls, each on its own row. Only the
 * initial reply is a send; every later operation updates the same card
 * entity and is safe to supersede or repeat. A reply never continues in
 * another message.
 */
export class LiveReply {
  private phase: 'thinking' | 'answering' | LiveReplyFinal['phase'] = 'thinking';
  private readonly steps: Step[] = [];
  private nextStep = 0;
  private trimmed = false;
  private answer = '';
  private separator = false;
  private mark = {steps: 0, tail: -1, answer: 0};
  private tools = 0;
  private note?: string;
  private footer?: string;
  private cardId?: string;
  private sequence = 0;
  private readonly sent = new Map<string, string>();
  private shown: string[] = [];
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
    let card: Record<string, unknown>;
    try { card = this.card(); this.cardId = await this.transport.createCardEntity(card); }
    catch { this.audit('live-card-unavailable'); return false; }
    this.streamingSince = this.now();
    this.markSent(card);
    try { await this.transport.replyCardEntity(this.target.messageId, this.cardId, {idempotencyKey: this.target.idempotencyKey, inThread: this.target.inThread}); }
    // The reply may still have been delivered. Never send another message for this
    // turn; updating a card nobody received is harmless.
    catch { this.audit('live-card-delivery-unknown'); }
    if (this.dirty) this.schedule();
    return true;
  }

  /** Trusted settings line under the answer, such as the model and thinking depth in use. */
  setFooter(text: string): void {
    if (this.closed || !text.trim() || text === this.footer) return;
    this.footer = text;
    this.layoutDirty = true;
    this.schedule();
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
        if (this.steps.length > this.mark.steps) this.layoutDirty = true;
        this.steps.length = Math.min(this.steps.length, this.mark.steps);
        const last = this.steps.at(-1);
        if (this.mark.tail >= 0 && last?.kind === 'reasoning') last.text = last.text.slice(0, this.mark.tail);
        this.answer = this.answer.slice(0, this.mark.answer);
        this.separator = this.answer.length > 0;
        // A discarded draft was the only answer so far: the reply is still at work.
        if (!this.answer && this.phase === 'answering') { this.phase = 'thinking'; this.answeredAt = undefined; this.layoutDirty = true; }
        break;
      }
      case 'reasoning': {
        const last = this.steps.at(-1);
        if (last?.kind === 'reasoning') last.text += event.text;
        else { this.steps.push({id: this.nextStep++, kind: 'reasoning', text: event.text}); this.layoutDirty = true; }
        this.trim();
        break;
      }
      case 'text':
        if (this.answer.length > 70_000) return;
        if (this.separator) { this.answer += '\n\n'; this.separator = false; }
        this.answer += event.text;
        // The folded panel's title switches from the current step to the time it took.
        if (this.phase === 'thinking') { this.phase = 'answering'; this.answeredAt = this.now(); this.layoutDirty = true; }
        break;
      case 'tool':
        if (this.steps.some(step => step.kind === 'tool' && step.callId === event.callId)) return;
        this.steps.push({id: this.nextStep++, kind: 'tool', callId: event.callId, name: event.name, state: 'running',
          ...(event.detail ? {detail: event.detail} : {}), ...(event.code ? {code: true} : {})});
        this.tools++;
        this.layoutDirty = true;
        this.trim();
        break;
      case 'tool-done': {
        const step = this.steps.find(item => item.kind === 'tool' && item.callId === event.callId);
        if (step?.kind !== 'tool') return;
        step.state = event.ok ? 'done' : 'failed';
        if (event.exitCode !== undefined) step.exitCode = event.exitCode;
        // The title names the running step, so it changes too.
        this.layoutDirty = true;
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
    if (final.reasoning && !this.steps.some(step => step.kind === 'reasoning')) this.steps.unshift({id: this.nextStep++, kind: 'reasoning', text: final.reasoning});
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
    while ((total > MAX_KEPT_CHARS || this.steps.length > MAX_ROWS * 2) && this.steps.length > 1) {
      const removed = this.steps.shift()!;
      total -= removed.kind === 'reasoning' ? removed.text.length : 200;
      this.mark.steps = Math.max(0, this.mark.steps - 1);
      this.trimmed = true;
      this.layoutDirty = true;
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
    const card = this.card();
    const elements = this.textElements(card);
    // Rows that appeared, left or moved need the whole card, which also sets the title.
    const layout = elements.filter(([id]) => id !== 'answer').map(([id]) => id).join() !== this.shown.join();
    if (this.degraded || this.layoutDirty || layout || this.now() - this.streamingSince > REOPEN_AFTER_MS) {
      this.layoutDirty = false;
      try {
        // A complete card also turns streaming mode back on.
        await this.transport.updateCardEntity(cardId, card, ++this.sequence);
        this.streamingSince = this.now();
        this.markSent(card);
        this.degraded = this.streamFailures >= 3;
      } catch { this.degraded = true; }
      return;
    }
    for (const [id, content] of elements) {
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

  /** Streamable text elements of a card: its process rows and the answer. */
  private textElements(card: Record<string, unknown>): Array<[string, string]> {
    const result: Array<[string, string]> = [];
    const visit = (items: unknown) => {
      for (const item of items as Array<Record<string, unknown>>) {
        if (Array.isArray(item.elements)) visit(item.elements);
        if (item.tag === 'markdown' && typeof item.element_id === 'string' && /^(?:s[0-9]+|answer)$/.test(item.element_id)) {
          result.push([item.element_id, item.content as string]);
        }
      }
    };
    visit((card.body as {elements: unknown[]}).elements);
    return result;
  }

  private markSent(card: Record<string, unknown>): void {
    const elements = this.textElements(card);
    this.sent.clear();
    for (const [id, content] of elements) this.sent.set(id, content);
    this.shown = elements.filter(([id]) => id !== 'answer').map(([id]) => id);
  }

  /** One step as a row, in the App's words: what was done and on what. */
  private row(step: Step, maxBytes = Infinity): Record<string, unknown> {
    if (step.kind === 'reasoning') {
      const text = step.text.trim();
      const shown = bytes(text) > maxBytes ? tail(text, Math.max(200, maxBytes)) : text;
      return {tag: 'markdown', element_id: `s${step.id}`, text_size: 'notation',
        icon: {tag: 'standard_icon', token: 'mindnote_outlined', color: 'grey'},
        content: (shown.length < text.length ? `${grey('…')}\n` : '') + (cardMarkdown(shown) || grey('正在思考…'))};
    }
    const {label, icon} = activity(step.name);
    const detail = step.detail ? ' · ' + (step.code ? code(step.detail) : grey(cardMarkdown(step.detail))) : '';
    const status = step.state === 'running' ? ` · ${grey('进行中…')}`
      : step.state === 'failed' ? ` · <font color='red'>失败</font>`
      : step.exitCode !== undefined ? ` · <font color='red'>退出码 ${step.exitCode}</font>` : '';
    return {tag: 'markdown', element_id: `s${step.id}`, text_size: 'notation',
      icon: {tag: 'standard_icon', token: icon, color: step.state === 'failed' || step.exitCode !== undefined ? 'red' : 'grey'},
      content: `${label}${detail}${status}`};
  }

  private answerContent(): string {
    if (!this.answer) return grey('…');
    const shown = head(this.answer, LIVE_ANSWER_BYTES);
    return cardMarkdown(shown) + (shown.length < this.answer.length ? `\n\n${grey('……')}` : '');
  }

  private panelTitle(): string {
    const tools = this.tools ? ` · ${this.tools} 次工具调用` : '';
    const seconds = (end?: number) => elapsed(Math.max(1, Math.round(((end ?? this.now()) - this.startedAt) / 1000)));
    switch (this.phase) {
      case 'thinking': {
        const running = [...this.steps].reverse().find(step => step.kind === 'tool' && step.state === 'running');
        if (running?.kind !== 'tool') return `正在思考…${tools}`;
        const detail = running.detail ? plainLabel(running.detail, 40) : '';
        return `${activity(running.name).doing}${detail ? ` · ${detail}` : '…'}`;
      }
      case 'answering': return `已思考 ${seconds(this.answeredAt)}${tools}`;
      case 'done': return `已完成，用时 ${seconds(this.finishedAt)}${tools}`;
      case 'stopped': return `已停止，用时 ${seconds(this.finishedAt)}${tools}`;
      case 'failed': return `处理失败，用时 ${seconds(this.finishedAt)}${tools}`;
    }
  }

  /** The folded process panel. Readers open it when they want the thinking and tool steps. */
  private panel(rows: Record<string, unknown>[]): Record<string, unknown> {
    return {
      tag: 'collapsible_panel', element_id: 'think_panel', expanded: false,
      header: {title: {tag: 'plain_text', content: this.panelTitle()}, vertical_align: 'center',
        icon: {tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px'}, icon_position: 'follow_text', icon_expanded_angle: -180},
      border: {color: 'grey', corner_radius: '5px'}, vertical_spacing: '6px', padding: '8px 8px 8px 8px',
      elements: rows.length ? rows : [{tag: 'markdown', element_id: 's_wait', content: grey('正在思考…'), text_size: 'notation'}],
    };
  }

  /**
   * The rows that fit in maxBytes, newest last. Older steps give way first and
   * leave a note; a single oversized thought keeps its most recent part.
   */
  private rows(maxBytes: number): Record<string, unknown>[] {
    const rows = this.steps.map(step => this.row(step));
    const sizes = rows.map(row => bytes(row) + 1);
    let total = sizes.reduce((sum, size) => sum + size, 0);
    let start = Math.max(0, rows.length - MAX_ROWS);
    for (let index = 0; index < start; index++) total -= sizes[index]!;
    while (start < rows.length - 1 && total > maxBytes) total -= sizes[start++]!;
    const shown = rows.slice(start);
    if (shown.length === 1 && total > maxBytes) shown[0] = this.row(this.steps[start]!, maxBytes - 400);
    if (start > 0 || this.trimmed) shown.unshift({tag: 'markdown', element_id: 'omitted', text_size: 'notation',
      content: grey('前面的步骤较多，这里只显示最近的部分；完整过程在电脑上的这段 Harness 会话里。')});
    return shown;
  }

  /** Live layout when final is undefined; a final layout otherwise (null leaves out the panel's rows). */
  private card(final?: {answer: string; rows: Record<string, unknown>[] | null; truncated: boolean}): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [];
    if (!final) elements.push(this.panel(this.rows(Math.max(1_000, CARD_BYTES - 3_000 - bytes(this.answerContent())))));
    else if (final.rows) elements.push(this.panel(final.rows));
    elements.push({tag: 'markdown', element_id: 'answer',
      content: final ? (final.answer.trim() ? cardMarkdown(final.answer) : grey('（没有文字回复）')) : this.answerContent()});
    const note = [this.note, final?.truncated ? TRUNCATED : undefined].filter(Boolean).join(' ');
    if (final && note) elements.push({tag: 'markdown', element_id: 'note', content: grey(cardMarkdown(note)), text_size: 'notation'});
    if (this.footer) elements.push({tag: 'markdown', element_id: 'footer', text_size: 'notation',
      icon: {tag: 'standard_icon', token: 'robot_outlined', color: 'grey'}, content: grey(cardMarkdown(this.footer))});
    const summary = final ? plainLabel(final.answer || this.note || '回复', 60) || '回复' : this.answer ? '正在回复…' : '正在思考…';
    return {
      schema: '2.0',
      config: {update_multi: true, enable_forward: false, width_mode: 'default', summary: {content: summary}, streaming_mode: !final,
        ...(final ? {} : {streaming_config: {print_frequency_ms: {default: 30}, print_step: {default: 2}, print_strategy: 'fast'}})},
      body: {direction: 'vertical', vertical_spacing: '8px', padding: '12px 16px 12px 16px', elements},
    };
  }

  /** The answer comes first. The folded process gets all the space that is left. */
  private finalCard(): Record<string, unknown> {
    // Reserve room for the folded title, so its time and tool count stay visible even beside a long answer.
    const minimal = this.steps.length ? [{tag: 'markdown', element_id: 'omitted', text_size: 'notation', content: grey('过程较长，卡片里没有显示；完整过程在电脑上的这段 Harness 会话里。')}] : null;
    let answer = this.answer, truncated = false;
    const fits = (candidate: string, rows: Record<string, unknown>[] | null) => bytes(this.card({answer: candidate, rows, truncated})) <= CARD_BYTES;
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
      let budget = CARD_BYTES - bytes(this.card({answer, rows: [], truncated})) - 200;
      while (budget > 300) {
        const rows = this.rows(budget);
        if (fits(answer, rows)) return this.card({answer, rows, truncated});
        budget = Math.floor(budget * 0.85);
      }
    }
    return this.card({answer, rows: minimal, truncated});
  }
}
