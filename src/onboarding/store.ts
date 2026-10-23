import {mkdir, open, readFile, rename, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {LarkBrand} from './lark-platform.js';

export interface ConnectionRecord {
  schema: 1;
  profile: string;
  appId: string;
  botOpenId?: string;
  brand: LarkBrand;
  creatorOpenId?: string;
  ownerOpenId?: string;
  ownerChatId?: string;
  enabled: boolean;
  verified: boolean;
  publishAttempted: boolean;
  cards: boolean;
  loading: boolean;
}
const id = (value: unknown, prefix: string) => typeof value === 'string' && new RegExp(`^${prefix}_[a-zA-Z0-9_-]{1,128}$`).test(value);
export function connectionRecord(raw: unknown): ConnectionRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid connection state');
  const x = raw as Record<string, unknown>;
  if (x.schema !== 1 || typeof x.profile !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(x.profile)
    || !id(x.appId, 'cli') || !['feishu', 'lark'].includes(String(x.brand))
    || ['enabled', 'verified', 'publishAttempted', 'cards', 'loading'].some(key => typeof x[key] !== 'boolean')
    || ['creatorOpenId', 'ownerOpenId', 'botOpenId'].some(key => x[key] !== undefined && !id(x[key], 'ou'))
    || (x.ownerChatId !== undefined && !id(x.ownerChatId, 'oc'))
    || Boolean(x.ownerOpenId) !== Boolean(x.ownerChatId) || (x.verified && (!x.ownerOpenId || !x.botOpenId))
    || (x.enabled && !x.verified)) {
    throw new Error('Invalid connection state');
  }
  // Whitelist persisted fields. SDK credentials can never survive this boundary.
  return {schema: 1, profile: x.profile, appId: x.appId as string, brand: x.brand as LarkBrand,
    botOpenId: x.botOpenId as string | undefined, creatorOpenId: x.creatorOpenId as string | undefined,
    ownerOpenId: x.ownerOpenId as string | undefined, ownerChatId: x.ownerChatId as string | undefined,
    enabled: x.enabled as boolean, verified: x.verified as boolean, publishAttempted: x.publishAttempted as boolean,
    cards: x.cards as boolean, loading: x.loading as boolean};
}

export class ConnectionStore {
  readonly directory: string;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(directory: string) {this.directory = resolve(directory);}
  async read(): Promise<ConnectionRecord | undefined> {
    try {return connectionRecord(JSON.parse(await readFile(join(this.directory, 'connection.json'), 'utf8')));}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
  }
  write(record: ConnectionRecord): Promise<void> {
    const safe = connectionRecord(record);
    const job = this.tail.then(async () => {
      await mkdir(this.directory, {recursive: true, mode: 0o700});
      const temp = join(this.directory, `connection.${randomUUID()}.tmp`);
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(safe)); await file.sync(); await file.close();
        await rename(temp, join(this.directory, 'connection.json'));
      } catch (error) {await file.close().catch(() => undefined); await rm(temp, {force: true}); throw error;}
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
}
