import { createHash } from 'node:crypto';
import type { BotConfig, UserPolicy } from './config.js';

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  senderId: string;
  chatType: 'p2p' | 'group';
  threadId: string;
  text: string;
}
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const validId = (v: unknown, prefix: string): v is string => typeof v === 'string' && new RegExp(`^${prefix}_[a-zA-Z0-9_-]+$`).test(v);

/** Accept only the verified, compact Lark CLI event contract. Fail closed on raw/unknown events. */
export function parseMessage(raw: unknown, botOpenId: string): IncomingMessage | undefined {
  const data = object(raw);
  if (!data || data.type !== 'im.message.receive_v1' || data.sender_type !== 'user') return;
  if (data.message_type !== 'text' && data.message_type !== 'post') return;
  if (!validId(data.message_id, 'om') || !validId(data.chat_id, 'oc') || !validId(data.sender_id, 'ou')) return;
  if (data.chat_type !== 'p2p' && data.chat_type !== 'group') return;
  if (typeof data.content !== 'string' || data.sender_id === botOpenId) return;
  const mentions = Array.isArray(data.mentions) ? data.mentions.map(object).filter(v => v !== undefined) : [];
  const ours = mentions.filter(m => m.id === botOpenId);
  if (data.chat_type === 'group' && ours.length === 0) return;
  // Text events render @name; rich posts can render <at user_id="...">.
  // Authorization always uses the structured open_id, never a display name.
  let text = data.content;
  for (const mention of ours) {
    if (typeof mention.key === 'string' && mention.key.length > 0) text = text.split(mention.key).join('');
  }
  text = text.replace(/<at\b[^>]*user_id=["']([^"']+)["'][^>]*>[^<]*<\/at>/g, (tag, userId: string) => userId === botOpenId ? '' : tag).trim();
  for (const mention of ours) {
    const rendered = typeof mention.name === 'string' && mention.name ? `@${mention.name}` : `@${botOpenId}`;
    if (text.startsWith(rendered) && (text.length === rendered.length || /\s/.test(text[rendered.length]!))) {
      text = text.slice(rendered.length).trimStart();
    }
  }
  if (!text) return;
  // Only a real Lark thread is its own conversation. A quote reply also carries
  // root_id, but it continues the chat's current conversation.
  const threadId = typeof data.thread_id === 'string' && /^(om|omt)_[a-zA-Z0-9_-]+$/.test(data.thread_id) ? data.thread_id : '';
  return {messageId: data.message_id, chatId: data.chat_id, senderId: data.sender_id, chatType: data.chat_type, threadId, text};
}
export function authorize(message: IncomingMessage, config: BotConfig): UserPolicy | undefined {
  const policy = config.users.find(user => user.openId === message.senderId);
  if (!policy) return;
  return (message.chatType === 'p2p' ? policy.direct : policy.groupChats.includes(message.chatId)) ? policy : undefined;
}
export function sessionKey(message: IncomingMessage, config: Pick<BotConfig, 'profile' | 'botOpenId'>): string {
  const identity = [config.profile, config.botOpenId, message.senderId, message.chatType, message.chatId, message.threadId];
  // Pre-privacy group memories may contain model-copied personal facts. Keep
  // them on disk but never import them into the explicit-write group boundary.
  if (message.chatType === 'group') identity.push('group-chat-private-v1');
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
/** A person owns long-term knowledge across their chats, within this bot/app. */
export function ownerKey(message: IncomingMessage, config: Pick<BotConfig, 'profile' | 'botOpenId'>): string {
  return createHash('sha256').update(JSON.stringify([config.profile, config.botOpenId, message.senderId])).digest('hex');
}
export function chunksByBytes(text: string, maxBytes: number): string[] {
  if (maxBytes < 4) throw new Error('chunk byte limit must be >= 4');
  const chunks: string[] = [];
  let chunk = '', size = 0;
  for (const point of text) {
    const bytes = Buffer.byteLength(point, 'utf8');
    if (size + bytes > maxBytes) { chunks.push(chunk); chunk = ''; size = 0; }
    chunk += point; size += bytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
