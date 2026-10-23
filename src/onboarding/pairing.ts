import {randomBytes, timingSafeEqual} from 'node:crypto';
import {LarkCli, noActiveConsumers} from '../lark-cli.js';
import {parseMessage, type IncomingMessage} from '../message.js';
import {acquireLock} from '../lock.js';
import {botLeaseDirectory} from '../bot-service.js';

export interface PairingChallenge {code: string; expiresAt: number}
export interface PairingTransport {
  start(onEvent: (raw: unknown) => void, onError: (error: Error) => void): Promise<void>;
  stop(): Promise<void>;
}
export class PairingError extends Error {
  constructor(public readonly code: 'EXPIRED' | 'ABORTED' | 'TRANSPORT' | 'BUSY') {super(`Pairing ${code}`);}
}
export const createChallenge = (now = Date.now()): PairingChallenge => ({
  code: `DSH-${randomBytes(12).toString('base64url')}`, expiresAt: now + 10 * 60_000,
});
export function matchesPairing(raw: unknown, botOpenId: string, challenge: PairingChallenge,
  expectedOwner?: string, now = Date.now()): IncomingMessage | undefined {
  if (now >= challenge.expiresAt || !raw || typeof raw !== 'object' || !('message_type' in raw) || raw.message_type !== 'text') return;
  const message = parseMessage(raw, botOpenId);
  if (!message || message.chatType !== 'p2p' || (expectedOwner && message.senderId !== expectedOwner)) return;
  const text = Buffer.from(message.text), code = Buffer.from(challenge.code);
  return text.length === code.length && timingSafeEqual(text, code) ? message : undefined;
}

/** Consumes only an exact private capability; all other incoming messages stay inert. */
export async function waitForPairing(input: {
  profile: string; botOpenId: string; challenge: PairingChallenge; expectedOwner?: string; signal: AbortSignal;
  executable?: string; transport?: PairingTransport; lease?: () => Promise<() => Promise<void>>;
}): Promise<IncomingMessage> {
  input.signal.throwIfAborted();
  let release: () => Promise<void>;
  try {
    release = await (input.lease ?? (() => acquireLock(botLeaseDirectory(input.botOpenId),
      {takeover: () => noActiveConsumers({profile: input.profile, executable: input.executable})})))();
  } catch {throw new PairingError('BUSY');}
  const transport = input.transport ?? new LarkCli({profile: input.profile, executable: input.executable});
  let expired: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => undefined;
  try {
    input.signal.throwIfAborted();
    return await new Promise<IncomingMessage>((resolve, reject) => {
      let settled = false;
      const fail = (code: 'ABORTED' | 'EXPIRED' | 'TRANSPORT') => {if (!settled) {settled = true; reject(new PairingError(code));}};
      abort = () => fail('ABORTED');
      input.signal.addEventListener('abort', abort, {once: true});
      expired = setTimeout(() => fail('EXPIRED'), Math.max(0, input.challenge.expiresAt - Date.now()));
      if (input.signal.aborted) {abort(); return;}
      void transport.start(raw => {
        if (settled) return;
        const message = matchesPairing(raw, input.botOpenId, input.challenge, input.expectedOwner);
        if (message) {settled = true; resolve(message);}
      }, () => fail('TRANSPORT')).catch(() => fail('TRANSPORT'));
    });
  } finally {
    clearTimeout(expired); input.signal.removeEventListener('abort', abort);
    // A failed shutdown retains the identity lease, preventing a second receiver.
    await transport.stop();
    await release();
  }
}
