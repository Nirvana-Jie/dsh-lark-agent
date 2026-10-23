import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface MessageLedger { claim(id: string): Promise<boolean> }

/** Durable claim-before-execution. On an ambiguous crash do not repeat a tool execution. */
export class DiskLedger implements MessageLedger {
  private entries = new Map<string, number>();
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<DiskLedger> {
    await mkdir(directory, {recursive: true, mode: 0o700});
    const ledger = new DiskLedger(directory);
    try {
      const rows: unknown = JSON.parse(await readFile(join(directory, 'messages.json'), 'utf8'));
      if (!Array.isArray(rows) || rows.length > 50_000) throw new Error('Invalid message ledger');
      for (const row of rows) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'number' || !Number.isFinite(row[1])) throw new Error('Invalid message ledger entry');
        ledger.entries.set(row[0], row[1]);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return ledger;
  }

  claim(id: string): Promise<boolean> {
    const job = this.tail.then(async () => {
      const now = Date.now();
      for (const [key, time] of this.entries) if (now - time > 7 * 86_400_000) this.entries.delete(key);
      if (this.entries.has(id)) return false;
      if (this.entries.size >= 50_000) throw new Error('Message ledger capacity reached');
      this.entries.set(id, now);
      const temp = join(this.directory, `messages.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify([...this.entries]), {mode: 0o600});
        await rename(temp, join(this.directory, 'messages.json'));
      } catch (error) {
        this.entries.delete(id);
        throw error;
      }
      return true;
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
}
