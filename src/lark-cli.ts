import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {basename, dirname, isAbsolute, join} from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {renderPanel, type ReplyPayload} from './replies.js';
import {topicLink, type TopicReceipt} from './topic-store.js';
import {topicEntryPanel} from './topic-cards.js';
import {mkdtemp, lstat, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import type {IncomingResource} from './message.js';
import {MAX_INPUT_AUDIO_BYTES, MAX_INPUT_IMAGE_BYTES} from './media-input.js';

export type LarkEventKey = 'im.message.receive_v1' | 'card.action.trigger' | 'application.bot.menu_v6';

export interface LarkCliOptions {
  executable?: string;
  profile: string;
  readyTimeoutMs?: number;
  commandTimeoutMs?: number;
  eventKey?: LarkEventKey;
}

const DEFAULT_EVENT_KEY: LarkEventKey = 'im.message.receive_v1';
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_STDERR_LINE_BYTES = 65_536;
const MAX_PENDING_EVENTS = 100;

interface Consumer {
  child: ChildProcessWithoutNullStreams;
  ready: boolean;
  stopping: boolean;
  closed: Promise<void>;
  rejectStart: (error: Error) => void;
}

interface ReplyProcess {
  cancel: () => void;
  closed: Promise<void>;
}

/** Bounded UTF-8 line decoding; transport diagnostics never include message bodies. */
function lines(limit: number, onLine: (line: string) => void, onOverflow: () => void) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let overflowed = false;
  return (chunk: Buffer) => {
    if (overflowed) return;
    pending += decoder.write(chunk);
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line) > limit) {
        overflowed = true;
        onOverflow();
        return;
      }
      onLine(line);
    }
    if (Buffer.byteLength(pending) > limit) {
      overflowed = true;
      onOverflow();
    }
  };
}

/**
 * True only for `lark-cli event status --current --json` output (larksuite/cli
 * cmd/event/status.go) showing this app's bus stopped, or running without consumers.
 * An orphan bus cannot be queried, so its consumers are unknown.
 */
export function consumerFree(value: unknown): boolean {
  const apps = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).apps : undefined;
  if (!Array.isArray(apps) || apps.length !== 1 || !apps[0] || typeof apps[0] !== 'object' || Array.isArray(apps[0])) return false;
  const app = apps[0] as Record<string, unknown>;
  if (app.status === 'not_running') return true;
  return app.status === 'running' && (app.active_consumers === undefined || app.active_consumers === 0)
    && (app.consumers === undefined || (Array.isArray(app.consumers) && app.consumers.length === 0));
}

/** Ask the bot profile's CLI whether any process still consumes this app's events; any doubt is "no". */
export function noActiveConsumers(options: {profile: string; executable?: string; timeoutMs?: number}): Promise<boolean> {
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.executable ?? 'lark-cli', ['--profile', options.profile, 'event', 'status', '--current', '--json'],
        {shell: false, windowsHide: true, stdio: 'pipe'});
    } catch {resolve(false); return;}
    const chunks: Buffer[] = [];
    let size = 0, settled = false;
    const finish = (free: boolean) => {if (!settled) {settled = true; clearTimeout(timer); resolve(free);}};
    const abandon = () => {finish(false); child.kill('SIGTERM');};
    const timer = setTimeout(abandon, options.timeoutMs ?? 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65_536) abandon(); else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    child.on('error', () => finish(false));
    child.on('close', code => {
      if (code !== 0) return finish(false);
      try {finish(consumerFree(JSON.parse(Buffer.concat(chunks).toString('utf8'))));} catch {finish(false);}
    });
    child.stdin.end();
  });
}

function timeout(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) {
    throw new Error('Lark CLI timeouts must be positive integer milliseconds.');
  }
  return result;
}

/** Bot-only subprocess transport. This object never exposes a user credential to an agent. */
export class LarkCli {
  private readonly executable: string;
  private readonly profile: string;
  private readonly readyTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly eventKey: LarkEventKey;
  private readonly readyMarker: string;
  private consumer?: Consumer;
  // Includes progress requests as well as replies; shutdown awaits every child.
  private readonly replies = new Map<ChildProcessWithoutNullStreams, ReplyProcess>();
  private stopping?: Promise<void>;
  private stoppingCancelsReplies = false;
  private stopped = false;

  constructor(options: LarkCliOptions) {
    this.executable = options.executable ?? 'lark-cli';
    this.profile = options.profile;
    this.eventKey = options.eventKey ?? DEFAULT_EVENT_KEY;
    if (this.eventKey !== 'im.message.receive_v1' && this.eventKey !== 'card.action.trigger' && this.eventKey !== 'application.bot.menu_v6') {
      throw new Error('Unsupported Lark event key.');
    }
    this.readyMarker = `[event] ready event_key=${this.eventKey}`;
    if (!this.executable.trim() || this.executable.includes('\0')) {
      throw new Error('A valid Lark CLI executable is required.');
    }
    if (!this.profile.trim() || this.profile.includes('\0')) {
      throw new Error('An explicit Lark CLI bot profile is required.');
    }
    this.readyTimeoutMs = timeout(options.readyTimeoutMs, 30_000);
    this.commandTimeoutMs = timeout(options.commandTimeoutMs, 30_000);
  }

  private launch(args: string[], cwd?: string): ChildProcessWithoutNullStreams {
    return spawn(this.executable, ['--profile', this.profile, ...args], {
      shell: false,
      windowsHide: true,
      stdio: 'pipe',
      ...(cwd ? {cwd} : {}),
    });
  }

  /** Downloads only the resource attached to the admitted real message, into a private temporary directory. */
  async readResource(resource: IncomingResource, signal: AbortSignal): Promise<Uint8Array> {
    if (!/^om_[A-Za-z0-9_-]{1,200}$/.test(resource.messageId)
      || !new RegExp(`^${resource.kind === 'image' ? 'img' : 'file'}_[A-Za-z0-9_-]{1,200}$`).test(resource.key)) throw new Error('Invalid message resource');
    const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-input-'));
    const path = join(directory, 'resource.bin');
    const limit = resource.kind === 'image' ? MAX_INPUT_IMAGE_BYTES : MAX_INPUT_AUDIO_BYTES;
    const aborter = new AbortController();
    const combined = AbortSignal.any([signal, aborter.signal]);
    // Abort growing downloads; the final read independently enforces the input cap.
    const monitor = setInterval(() => {void lstat(path).then(info => {
      if (info.isSymbolicLink() || !info.isFile() || info.size > limit) aborter.abort();
    }).catch(() => undefined);}, 25);
    try {
      await this.executeMedia(['im', '+messages-resources-download', '--message-id', resource.messageId, '--file-key', resource.key,
        '--type', resource.kind === 'image' ? 'image' : 'file', '--output', './resource.bin', '--as', 'bot', '--format', 'json'], '', combined, directory);
      signal.throwIfAborted();
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > limit) throw new Error('Message resource exceeds its input limit');
      const bytes = await readFile(path);
      if (bytes.length > limit || bytes.length !== info.size) throw new Error('Message resource changed while reading');
      return bytes;
    } finally {clearInterval(monitor); await rm(directory, {recursive: true, force: true});}
  }

  /** Feishu's tenant ASR, using the same dedicated bot profile and credentials. */
  async recognizeSpeech(pcm: Uint8Array, signal: AbortSignal): Promise<string> {
    if (!pcm.byteLength || pcm.byteLength > 60 * 16000 * 2) throw new Error('Invalid speech input');
    const result = await this.executeMedia(['api', 'POST', '/open-apis/speech_to_text/v1/speech/file_recognize', '--as', 'bot', '--data', '-', '--format', 'json'],
      JSON.stringify({config: {file_id: randomUUID().replaceAll('-', '').slice(0, 16), format: 'pcm', engine_type: '16k_auto'},
        speech: {speech: Buffer.from(pcm).toString('base64')}}), signal);
    const data = result.data as {recognition_text?: unknown} | undefined;
    if (typeof data?.recognition_text !== 'string' || !data.recognition_text.trim() || data.recognition_text.length > 100_000) throw new Error('Speech result is unavailable');
    return data.recognition_text;
  }

  /** Media reads drain the child before cleanup, including cancellation and forced termination. */
  private executeMedia(args: string[], input: string, signal: AbortSignal, cwd?: string): Promise<Record<string, unknown>> {
    if (this.stopped) return Promise.reject(new Error('Lark transport is stopped'));
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const child = this.launch(args, cwd);
      const chunks: Buffer[] = [];
      let failure: Error | undefined, size = 0;
      let kill: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        failure ??= new Error('Lark media operation was stopped');
        child.kill('SIGTERM'); kill ??= setTimeout(() => child.kill('SIGKILL'), 1000);
      };
      let resolveClosed!: () => void;
      const closed = new Promise<void>(done => {resolveClosed = done;});
      this.replies.set(child, {cancel, closed});
      const timer = setTimeout(cancel, this.commandTimeoutMs);
      signal.addEventListener('abort', cancel, {once: true});
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) {cancel(); return;}
        if (!failure) chunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk: Buffer) => {size += chunk.length; if (size > MAX_OUTPUT_BYTES) cancel();});
      child.stdin.on('error', cancel);
      child.on('error', () => {failure = new Error('Lark media command is unavailable');});
      child.on('close', code => {
        clearTimeout(timer); clearTimeout(kill); signal.removeEventListener('abort', cancel);
        this.replies.delete(child); resolveClosed();
        if (failure || code !== 0) {reject(failure ?? new Error('Lark media command failed')); return;}
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          if (value?.ok !== true) throw new Error();
          resolve(value);
        } catch {reject(new Error('Lark media command did not confirm success'));}
      });
      child.stdin.end(input);
    });
  }

  start(onEvent: (raw: unknown) => void, onError: (err: Error) => void): Promise<void> {
    if (this.consumer) return Promise.reject(new Error('Lark event consumer is already running.'));
    if (this.stopping || (this.stopped && this.replies.size > 0)) {
      return Promise.reject(new Error('Lark transport is still stopping.'));
    }
    this.stopped = false;
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.launch(['event', 'consume', this.eventKey, '--as', 'bot']);
      } catch {
        reject(new Error('Could not start the Lark event consumer.'));
        return;
      }
      let resolveClosed!: () => void;
      const consumer: Consumer = {
        child,
        ready: false,
        stopping: false,
        closed: new Promise<void>((done) => { resolveClosed = done; }),
        rejectStart: (error) => {
          clearTimeout(readyTimer);
          reject(error);
        },
      };
      this.consumer = consumer;
      let failed = false;
      const pending: string[] = [];
      let pendingBytes = 0;
      const report = (error: Error) => {
        // Error callbacks belong to the host; an exception must not crash a stream callback.
        try { onError(error); } catch { /* Host owns logging. */ }
      };
      const fail = (message: string) => {
        if (failed || consumer.stopping) return;
        failed = true;
        consumer.stopping = true;
        clearTimeout(readyTimer);
        pending.length = 0;
        const error = new Error(message);
        if (consumer.ready) report(error);
        else reject(error);
        child.stdin.end();
        child.kill('SIGTERM');
      };
      const deliver = (line: string) => {
        if (consumer.stopping || !line.trim()) return;
        let event: unknown;
        try { event = JSON.parse(line); } catch {
          fail('Lark event consumer emitted invalid JSON.');
          return;
        }
        try { onEvent(event); } catch {
          report(new Error('Lark event handler failed.'));
        }
      };
      const readyTimer = setTimeout(() => {
        fail('Lark event consumer did not become ready before the deadline.');
      }, this.readyTimeoutMs);

      child.stdout.on('data', lines(MAX_OUTPUT_BYTES, (line) => {
        if (consumer.stopping || !line.trim()) return;
        if (consumer.ready) return deliver(line);
        pendingBytes += Buffer.byteLength(line);
        if (pending.length >= MAX_PENDING_EVENTS || pendingBytes > MAX_OUTPUT_BYTES) {
          fail('Lark event consumer exceeded the buffer before readiness.');
          return;
        }
        pending.push(line);
      }, () => fail('Lark event consumer emitted an oversized event.')));
      child.stderr.on('data', lines(MAX_STDERR_LINE_BYTES, (line) => {
        if (consumer.stopping) return;
        // The CLI reports sequence gaps, backpressure drops, invalid events and
        // processing failures only on stderr. Do not silently keep a healthy
        // connection state after loss, and never forward its potentially private text.
        if (/^WARN:.*(?:\bdropp(?:ed|ing)\b|\bmissed\b|\bskipping event\b|\bProcess error:|\bJQ error:)/.test(line)) {
          fail('Lark event consumer reported an integrity warning; events may have been lost.');
          return;
        }
        if (line.startsWith('{')) {
          try {
            const diagnostic: unknown = JSON.parse(line);
            if (diagnostic && typeof diagnostic === 'object' && 'ok' in diagnostic && diagnostic.ok === false) {
              fail('Lark event consumer reported a command failure.');
              return;
            }
          } catch { /* Ordinary diagnostics are not JSON envelopes. */ }
        }
        if (consumer.ready || line !== this.readyMarker) return;
        consumer.ready = true;
        clearTimeout(readyTimer);
        resolve();
        for (const event of pending) deliver(event);
        pending.length = 0;
      }, () => fail('Lark event consumer emitted oversized diagnostics.')));
      child.stdin.on('error', () => fail('Lark event consumer input stream failed.'));
      child.on('error', () => fail('Could not run the Lark event consumer.'));
      child.on('close', (code, signal) => {
        clearTimeout(readyTimer);
        if (!consumer.stopping) {
          fail(`Lark event consumer exited unexpectedly (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`);
        }
        if (this.consumer === consumer) this.consumer = undefined;
        resolveClosed();
      });
      // Keep stdin open: unbounded `event consume` treats EOF as a shutdown request.
    });
  }

  stop(options: { cancelReplies?: boolean } = {}): Promise<void> {
    const cancelReplies = options.cancelReplies ?? true;
    if (cancelReplies) this.stopped = true;
    if (this.stopping && (!cancelReplies || this.stoppingCancelsReplies)) return this.stopping;
    // Full disposal may arrive while a consumer-only reconnect is stopping.
    // It must still cancel and await replies before the host releases its lock.
    const previous = this.stopping;
    const operation = previous
      ? previous.catch(() => undefined).then(() => this.stopChildren(cancelReplies))
      : this.stopChildren(cancelReplies);
    this.stopping = operation;
    this.stoppingCancelsReplies = cancelReplies;
    const clear = () => { if (this.stopping === operation) this.stopping = undefined; };
    void operation.then(clear, clear);
    return operation;
  }

  private async stopChildren(cancelReplies: boolean): Promise<void> {
    const replies = cancelReplies ? [...this.replies.values()] : [];
    for (const reply of replies) reply.cancel();
    const consumer = this.consumer;
    const closed = replies.map(reply => reply.closed);
    if (consumer) {
      consumer.stopping = true;
      if (!consumer.ready) consumer.rejectStart(new Error('Lark event consumer stopped before readiness.'));
      consumer.child.stdin.end();
      closed.push(consumer.closed);
    }
    if (closed.length === 0) return;
    let terminateTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(closed),
        new Promise<never>((_, reject) => {
          terminateTimer = setTimeout(() => {
            if (consumer && this.consumer === consumer) consumer.child.kill('SIGTERM');
          }, 500);
          deadlineTimer = setTimeout(() => {
            reject(new Error('Lark subprocesses did not stop after SIGTERM; shutdown is incomplete.'));
          }, 5_000);
        }),
      ]);
    } finally {
      clearTimeout(terminateTimer);
      clearTimeout(deadlineTimer);
    }
  }

  reply(messageId: string, text: string, options: { idempotencyKey: string; inThread: boolean }): Promise<void> {
    return this.replyRich(messageId, {kind: 'text', text}, options);
  }

  sendUser(openId: string, text: string, options: {idempotencyKey: string}): Promise<void> {
    return this.sendRichUser(openId, {kind: 'text', text}, options);
  }

  /** Open a native topic and keep its raw receipt; the reply shortcut drops thread_id. */
  async openTopic(target: {chatId: string; messageId?: string}, title: string,
    options: {idempotencyKey: string; chatType?: 'p2p' | 'group'; textOnly?: boolean}): Promise<TopicReceipt> {
    if (!target || typeof target.chatId !== 'string' || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(target.chatId)
      || (target.messageId !== undefined && !/^om_[A-Za-z0-9_-]{1,256}$/.test(target.messageId))
      || typeof title !== 'string' || !title.trim() || Array.from(title).length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(title)
      || !/^[A-Za-z0-9._:-]{1,45}$/.test(options?.idempotencyKey)
      || (options.chatType !== undefined && options.chatType !== 'p2p' && options.chatType !== 'group')
      || (options.textOnly !== undefined && typeof options.textOnly !== 'boolean')) throw new Error('Invalid Lark topic target.');
    const text = `话题：${title}\n请在这个话题里继续。${options.chatType === 'group' ? '群聊中每条消息仍需 @机器人。' : ''}`;
    const entry = options.textOnly ? {msg_type: 'text', content: JSON.stringify({text})}
      : {msg_type: 'interactive', content: this.feedbackContent(renderPanel(topicEntryPanel(title, options.chatType ?? 'p2p')))};
    const request = async (path: string, data: Record<string, unknown>, params?: string) => {
      const result = await this.executeJson(['api', 'POST', path, ...(params ? ['--params', params] : []),
        '--data', '-', '--as', 'bot', '--format', 'json'], JSON.stringify(data), 'reply', this.commandTimeoutMs);
      this.confirmFeedback(result);
      const receipt = result.data as Record<string, unknown> | undefined;
      if (!receipt || typeof receipt.message_id !== 'string' || !/^om_[A-Za-z0-9_-]{1,256}$/.test(receipt.message_id)
        || receipt.chat_id !== target.chatId) throw new Error('Lark topic creation was not confirmed; delivery is unknown.');
      return receipt;
    };
    let anchor = target.messageId;
    let entryMessageId: string | undefined;
    let receipt: Record<string, unknown> | undefined;
    if (!anchor) {
      // Menu events and replies inside another topic cannot be used as a new root.
      // Confirm the root before replying; never invent a message ID or retry an unknown send.
      receipt = await request('/open-apis/im/v1/messages', {receive_id: target.chatId, ...entry,
        uuid: `${options.idempotencyKey}:root`}, '{"receive_id_type":"chat_id"}');
      anchor = receipt.message_id as string;
      entryMessageId = anchor;
    }
    if (!receipt?.thread_id) receipt = await request(`/open-apis/im/v1/messages/${anchor}/reply`,
      {...(target.messageId ? entry : {msg_type: 'text', content: JSON.stringify({text: `在这里发送消息继续。${options.chatType === 'group' ? '每条消息仍需 @机器人。' : ''}`})}),
        reply_in_thread: true, uuid: `${options.idempotencyKey}:open`});
    if (typeof receipt.thread_id !== 'string' || !/^(?:om|omt)_[A-Za-z0-9_-]{1,256}$/.test(receipt.thread_id)) {
      throw new Error('Lark topic creation did not return a thread ID; delivery is unknown.');
    }
    // Updates must target our entry card, never the text reply that only opens
    // a menu-created root's thread. For user roots, the first bot reply is the card.
    const messageId = entryMessageId ?? receipt.message_id as string;
    const link = await this.topicLink(messageId);
    return {threadId: receipt.thread_id, messageId, ...(link ? {link} : {})};
  }

  /** Optional read enrichment. A missing link must never cause another topic creation. */
  async topicLink(messageId: string): Promise<string | undefined> {
    if (!/^om_[A-Za-z0-9_-]{1,256}$/.test(messageId)) throw new Error('Invalid Lark topic anchor.');
    try {
      const result = await this.executeJson(['im', '+messages-mget', '--message-ids', messageId, '--no-reactions',
        '--as', 'bot', '--format', 'json'], '', 'read', Math.min(this.commandTimeoutMs, 5_000));
      this.confirmFeedback(result);
      const data = result.data as Record<string, unknown> | undefined;
      const rows = data?.messages ?? result.messages;
      if (!Array.isArray(rows)) return;
      const message = rows.find(row => row && typeof row === 'object' && row.message_id === messageId) as Record<string, unknown> | undefined;
      return topicLink(message?.thread_app_link) ?? topicLink(message?.message_app_link);
    } catch {return;}
  }

  /** Create a short-lived loading card; its receipt stays inside the bridge. */
  async createFeedback(target: {openId: string} | {messageId: string; inThread: boolean}, payload: ReplyPayload,
    options: {idempotencyKey: string}): Promise<string> {
    const content = this.feedbackContent(payload);
    if (!target || typeof target !== 'object' || Array.isArray(target)
      || typeof options?.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,50}$/.test(options.idempotencyKey)) {
      throw new Error('Invalid Lark feedback target.');
    }
    let args: string[], data: Record<string, unknown>;
    if ('openId' in target) {
      if (typeof target.openId !== 'string' || !/^ou_[A-Za-z0-9_-]{1,128}$/.test(target.openId)
        || Object.keys(target).some(key => key !== 'openId')) throw new Error('Invalid Lark feedback target.');
      args = ['api', 'POST', '/open-apis/im/v1/messages', '--params', '{"receive_id_type":"open_id"}'];
      data = {receive_id: target.openId, msg_type: 'interactive', content, uuid: options.idempotencyKey};
    } else {
      if (typeof target.messageId !== 'string' || !/^om_[A-Za-z0-9_-]{1,256}$/.test(target.messageId)
        || typeof target.inThread !== 'boolean' || Object.keys(target).some(key => key !== 'messageId' && key !== 'inThread')) {
        throw new Error('Invalid Lark feedback target.');
      }
      args = ['api', 'POST', `/open-apis/im/v1/messages/${target.messageId}/reply`];
      data = {msg_type: 'interactive', content, uuid: options.idempotencyKey, reply_in_thread: target.inThread};
    }
    const body = JSON.stringify(data);
    if (Buffer.byteLength(body) > 29_000) throw new Error('Lark feedback exceeds the message byte limit.');
    const result = await this.executeJson([...args, '--data', '-', '--as', 'bot', '--format', 'json'], body,
      'feedback', Math.min(this.commandTimeoutMs, 5_000));
    this.confirmFeedback(result);
    const receipt = result.data as Record<string, unknown> | undefined;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || typeof receipt.message_id !== 'string' || !/^om_[A-Za-z0-9_-]{1,256}$/.test(receipt.message_id)
      || typeof receipt.chat_id !== 'string' || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(receipt.chat_id)) {
      throw new Error('Lark feedback command did not confirm message creation; delivery is unknown.');
    }
    return receipt.message_id;
  }

  /** Replace one bot-owned loading/interactive card, never retry an unknown update. */
  async updateFeedback(messageId: string, payload: ReplyPayload): Promise<void> {
    if (typeof messageId !== 'string' || !/^om_[A-Za-z0-9_-]{1,256}$/.test(messageId)) throw new Error('Invalid Lark feedback target.');
    const body = JSON.stringify({content: this.feedbackContent(payload)});
    if (Buffer.byteLength(body) > 29_000) throw new Error('Lark feedback exceeds the message byte limit.');
    const result = await this.executeJson(['api', 'PATCH', `/open-apis/im/v1/messages/${messageId}`,
      '--data', '-', '--as', 'bot', '--format', 'json'], body, 'feedback', Math.min(this.commandTimeoutMs, 5_000));
    this.confirmFeedback(result);
  }

  private feedbackContent(payload: ReplyPayload): string {
    try {
      if (payload.kind !== 'card' || !payload.card || typeof payload.card !== 'object' || Array.isArray(payload.card)) throw new Error();
      // Normalize to JSON before enforcing shared-card updates, so a custom
      // serializer cannot omit or replace the mandatory update_multi setting.
      const card: unknown = JSON.parse(JSON.stringify(payload.card));
      if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error();
      const object = card as Record<string, unknown>, config = object.config;
      if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) throw new Error();
      return JSON.stringify({...object, config: {...config as Record<string, unknown> | undefined, update_multi: true}});
    } catch {throw new Error('Invalid Lark feedback card.');}
  }

  /** Create a CardKit card entity. Nothing reaches a chat yet, so a failure needs no delivery guard. */
  async createCardEntity(card: Record<string, unknown>): Promise<string> {
    const data = this.cardEntityData(card);
    const result = await this.executeJson(['api', 'POST', '/open-apis/cardkit/v1/cards', '--data', '-', '--as', 'bot', '--format', 'json'],
      JSON.stringify({type: 'card_json', data}), 'card', Math.min(this.commandTimeoutMs, 10_000));
    this.confirmFeedback(result);
    const receipt = result.data as Record<string, unknown> | undefined;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || !LarkCli.cardId(receipt.card_id)) {
      throw new Error('Lark card entity creation was not confirmed.');
    }
    return receipt.card_id;
  }

  /** Reply with a card entity. An unconfirmed reply may still have been delivered; never resend it. */
  async replyCardEntity(messageId: string, cardId: string, options: {idempotencyKey: string; inThread: boolean}): Promise<void> {
    if (typeof messageId !== 'string' || !/^om_[A-Za-z0-9_-]{1,256}$/.test(messageId) || !LarkCli.cardId(cardId)
      || typeof options?.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,50}$/.test(options.idempotencyKey)
      || typeof options.inThread !== 'boolean') throw new Error('Invalid Lark card reply.');
    const body = JSON.stringify({msg_type: 'interactive', content: JSON.stringify({type: 'card', data: {card_id: cardId}}),
      uuid: options.idempotencyKey, reply_in_thread: options.inThread});
    const result = await this.executeJson(['api', 'POST', `/open-apis/im/v1/messages/${messageId}/reply`,
      '--data', '-', '--as', 'bot', '--format', 'json'], body, 'reply', this.commandTimeoutMs);
    this.confirmFeedback(result);
    const receipt = result.data as Record<string, unknown> | undefined;
    if (!receipt || typeof receipt !== 'object' || typeof receipt.message_id !== 'string' || !/^om_[A-Za-z0-9_-]{1,256}$/.test(receipt.message_id)) {
      throw new Error('Lark card reply was not confirmed; delivery is unknown.');
    }
  }

  /** Stream one element's complete text. Any later update supersedes a failed one. */
  async streamCardText(cardId: string, elementId: string, content: string, sequence: number): Promise<void> {
    if (!LarkCli.cardId(cardId) || typeof elementId !== 'string' || !/^[a-z][a-z0-9_]{0,19}$/.test(elementId)
      || typeof content !== 'string' || !content || Buffer.byteLength(content) > 100_000 || !LarkCli.sequence(sequence)) {
      throw new Error('Invalid Lark card stream update.');
    }
    const result = await this.executeJson(['api', 'PUT', `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
      '--data', '-', '--as', 'bot', '--format', 'json'], JSON.stringify({content, sequence, uuid: randomUUID()}), 'card',
    Math.min(this.commandTimeoutMs, 10_000));
    this.confirmFeedback(result);
  }

  /** Replace a card entity. Applying the same state twice is harmless, so callers may retry with a newer sequence. */
  async updateCardEntity(cardId: string, card: Record<string, unknown>, sequence: number): Promise<void> {
    if (!LarkCli.cardId(cardId) || !LarkCli.sequence(sequence)) throw new Error('Invalid Lark card update.');
    const data = this.cardEntityData(card);
    const result = await this.executeJson(['api', 'PUT', `/open-apis/cardkit/v1/cards/${cardId}`, '--data', '-', '--as', 'bot', '--format', 'json'],
      JSON.stringify({card: {type: 'card_json', data}, sequence, uuid: randomUUID()}), 'card', Math.min(this.commandTimeoutMs, 10_000));
    this.confirmFeedback(result);
  }

  /**
   * Reply with one local file the caller has already validated. Only a
   * `./basename` crosses argv, resolved from the file's own directory, so it
   * can never be read as an upload key, a URL or another flag.
   */
  async replyFile(messageId: string, path: string, options: {idempotencyKey: string; inThread: boolean; image: boolean}): Promise<void> {
    const name = typeof path === 'string' ? basename(path) : '';
    if (typeof messageId !== 'string' || !/^om_[A-Za-z0-9_-]{1,256}$/.test(messageId) || typeof path !== 'string' || !isAbsolute(path)
      || /[\\/]$/.test(path) || !name || name.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(name) || name === '.' || name === '..'
      || typeof options?.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,50}$/.test(options.idempotencyKey)
      || typeof options.inThread !== 'boolean' || typeof options.image !== 'boolean') throw new Error('Invalid Lark file reply.');
    const args = ['im', '+messages-reply', '--message-id', messageId, `--${options.image ? 'image' : 'file'}=./${name}`,
      '--as', 'bot', '--format', 'json', '--idempotency-key', options.idempotencyKey];
    if (options.inThread) args.push('--reply-in-thread');
    // Uploads take longer than text; the deadline still bounds an unknown result.
    await this.executeJson(args, '', 'reply', Math.max(this.commandTimeoutMs, 120_000), dirname(path));
  }

  private cardEntityData(card: Record<string, unknown>): string {
    let data: string;
    try {
      if (!card || typeof card !== 'object' || Array.isArray(card) || card.schema !== '2.0') throw new Error();
      data = JSON.stringify(card);
    } catch {throw new Error('Invalid Lark card entity.');}
    // CardKit rejects cards over 30 KB; keep a margin for the request envelope.
    if (Buffer.byteLength(data) > 28_500) throw new Error('Lark card entity exceeds the size limit.');
    return data;
  }

  private static cardId(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(value);
  }

  private static sequence(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
  }

  private confirmFeedback(result: Record<string, unknown>): void {
    if (result.identity !== 'bot' || (result.dry_run !== undefined && result.dry_run !== false)) {
      throw new Error('Lark feedback command did not confirm bot delivery; delivery is unknown.');
    }
  }

  /** Menu events have no message ID: create a message for the verified actor instead. */
  sendRichUser(openId: string, payload: ReplyPayload, options: {idempotencyKey: string}): Promise<void> {
    let body: string;
    try {
      if (typeof openId !== 'string' || !/^ou_[A-Za-z0-9_-]{1,128}$/.test(openId)
        || typeof options?.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,50}$/.test(options.idempotencyKey)) {
        throw new Error();
      }
      let msgType: 'text' | 'post' | 'interactive', content: string;
      if (payload.kind === 'text' && typeof payload.text === 'string' && payload.text.trim()) {
        msgType = 'text'; content = JSON.stringify({text: payload.text});
      } else if (payload.kind === 'post' && typeof payload.markdown === 'string' && payload.markdown.trim()) {
        msgType = 'post'; content = JSON.stringify({zh_cn: {content: [[{tag: 'md', text: payload.markdown}]]}});
      } else if (payload.kind === 'card' && payload.card && typeof payload.card === 'object' && !Array.isArray(payload.card)) {
        msgType = 'interactive'; content = JSON.stringify(payload.card);
      } else throw new Error();
      body = JSON.stringify({receive_id: openId, msg_type: msgType, content, uuid: options.idempotencyKey});
    } catch {return Promise.reject(new Error('Invalid Lark outbound message.'));}
    if (Buffer.byteLength(body) > 29_000) return Promise.reject(new Error('Lark outbound message exceeds the message byte limit.'));
    return this.executeJson(['api', 'POST', '/open-apis/im/v1/messages', '--params', '{"receive_id_type":"open_id"}',
      '--data', '-', '--as', 'bot', '--format', 'json'], body, 'send', this.commandTimeoutMs).then(result => {
      const data = result.data as Record<string, unknown> | undefined;
      if (result.identity !== 'bot' || result.dry_run === true || !data || typeof data !== 'object'
        || typeof data.message_id !== 'string' || !/^om_[A-Za-z0-9_-]{1,256}$/.test(data.message_id)
        || typeof data.chat_id !== 'string' || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(data.chat_id)) {
        throw new Error('Lark send command did not confirm bot delivery; delivery is unknown.');
      }
    });
  }

  replyRich(messageId: string, payload: ReplyPayload, options: { idempotencyKey: string; inThread: boolean }): Promise<void> {
    let input: string;
    let contentArgs: string[];
    try {
      if (payload.kind === 'text' && typeof payload.text === 'string') {
        input = payload.text;
        contentArgs = ['--text', '-'];
      } else if (payload.kind === 'post' && typeof payload.markdown === 'string' && payload.markdown.trim()) {
        // Use a native md node. --markdown would let the CLI download/upload
        // model-provided image URLs while converting the content to a post.
        input = JSON.stringify({zh_cn: {content: [[{tag: 'md', text: payload.markdown}]]}});
        contentArgs = ['--msg-type', 'post', '--content', '-'];
      } else if (payload.kind === 'card' && payload.card && typeof payload.card === 'object' && !Array.isArray(payload.card)) {
        // The renderer owns schema validation; interactive content is the bare
        // Card JSON, not another message envelope or a shell argument.
        input = JSON.stringify(payload.card);
        contentArgs = ['--msg-type', 'interactive', '--content', '-'];
      } else {
        return Promise.reject(new Error('Invalid Lark reply payload.'));
      }
    } catch {
      return Promise.reject(new Error('Invalid Lark reply payload.'));
    }
    if (typeof input !== 'string') return Promise.reject(new Error('Invalid Lark reply payload.'));
    if (payload.kind !== 'text' && Buffer.byteLength(JSON.stringify({msg_type: payload.kind === 'card' ? 'interactive' : 'post',
      content: input, uuid: options.idempotencyKey, reply_in_thread: options.inThread})) > 29_000) {
      return Promise.reject(new Error('Lark rich reply exceeds the message byte limit.'));
    }
    return this.sendReply(messageId, input, contentArgs, options, payload.kind === 'post');
  }

  async startProgress(messageId: string): Promise<string> {
    if (!/^om_[A-Za-z0-9_-]{1,256}$/.test(messageId)) throw new Error('Invalid Lark progress target.');
    const result = await this.executeJson(['im', 'reactions', 'create', '--message-id', messageId,
      '--data', '-', '--as', 'bot', '--format', 'json'], JSON.stringify({reaction_type: {emoji_type: 'Typing'}}),
    'progress', Math.min(this.commandTimeoutMs, 5_000));
    const data = result.data;
    const id = data && typeof data === 'object' && 'reaction_id' in data ? data.reaction_id : undefined;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_=-]{1,512}$/.test(id)) throw new Error('Lark progress command did not return a valid reaction ID.');
    return id;
  }

  async finishProgress(messageId: string, reactionId: string): Promise<void> {
    if (!/^om_[A-Za-z0-9_-]{1,256}$/.test(messageId) || !/^[A-Za-z0-9_=-]{1,512}$/.test(reactionId)) {
      throw new Error('Invalid Lark progress target.');
    }
    // The returned opaque reaction ID stays in stdin instead of process argv.
    await this.executeJson(['im', 'reactions', 'delete', '--params', '-', '--as', 'bot', '--format', 'json'],
      JSON.stringify({message_id: messageId, reaction_id: reactionId}), 'progress', Math.min(this.commandTimeoutMs, 5_000));
  }

  private sendReply(messageId: string, input: string, contentArgs: string[], options: { idempotencyKey: string; inThread: boolean }, rawPost = false): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Lark transport is stopped.'));
    if (!messageId.startsWith('om_') || !input.trim() || !options.idempotencyKey || options.idempotencyKey.length > 50) {
      return Promise.reject(new Error('Invalid Lark reply arguments.'));
    }
    if (Buffer.byteLength(input) > MAX_OUTPUT_BYTES) {
      return Promise.reject(new Error('Lark reply exceeds the transport input limit.'));
    }
    if (rawPost) {
      // The shortcut normalizes <at> with a regex over already-serialized JSON.
      // A literal unquoted <at id=all> inside code would corrupt that JSON.
      // Use the documented reply endpoint so code is delivered unchanged.
      const body = JSON.stringify({msg_type: 'post', content: input, uuid: options.idempotencyKey, reply_in_thread: options.inThread});
      return this.executeJson(['api', 'POST', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
        '--data', '-', '--as', 'bot', '--format', 'json'], body, 'reply', this.commandTimeoutMs).then(() => undefined);
    }
    const args = ['im', '+messages-reply', '--message-id', messageId, ...contentArgs, '--as', 'bot',
      '--format', 'json', '--idempotency-key', options.idempotencyKey];
    if (options.inThread) args.push('--reply-in-thread');
    return this.executeJson(args, input, 'reply', this.commandTimeoutMs).then(() => undefined);
  }

  private executeJson(args: string[], input: string, operation: 'reply' | 'progress' | 'send' | 'feedback' | 'card' | 'read', deadlineMs: number,
    cwd?: string): Promise<Record<string, unknown>> {
    if (this.stopped) return Promise.reject(new Error('Lark transport is stopped.'));
    const label = `Lark ${operation} command`;
    const uncertain = operation === 'progress' || operation === 'card' || operation === 'read' ? 'result is unknown.' : 'delivery is unknown.';
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = this.launch(args, cwd); } catch {
        reject(new Error(`Could not start the Lark ${operation} command.`));
        return;
      }
      const chunks: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (error?: Error, result?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result ?? {});
      };
      const cancel = (message = `${label} was stopped.`) => {
        finish(new Error(message));
        child.stdin.end();
        child.kill('SIGTERM');
      };
      let resolveClosed!: () => void;
      const closed = new Promise<void>((done) => { resolveClosed = done; });
      this.replies.set(child, { cancel, closed });
      const timer = setTimeout(() => cancel(`${label} exceeded its deadline; ${uncertain}`), deadlineMs);
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) return cancel(`${label} exceeded its output limit; ${uncertain}`);
        chunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) cancel(`${label} exceeded its output limit; ${uncertain}`);
      });
      child.stdin.on('error', () => cancel(`${label} input failed; ${uncertain}`));
      child.on('error', () => finish(new Error(`Could not run the Lark ${operation} command.`)));
      child.on('close', (code) => {
        this.replies.delete(child);
        resolveClosed();
        if (settled) return;
        if (code !== 0) return finish(new Error(`${label} failed (exit ${code ?? 'signal'}); ${uncertain}`));
        try {
          const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
            finish(new Error(`${label} did not confirm success; ${uncertain}`));
            return;
          }
          finish(undefined, result as Record<string, unknown>);
        } catch {
          finish(new Error(`${label} returned invalid JSON; ${uncertain}`));
        }
      });
      // stdin avoids shell interpolation and CLI @file/- interpretation of generated text.
      child.stdin.end(input);
    });
  }
}
