import {mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

/** A failed publication poisons this writer until the owner reloads from disk. */
export class SettingsStore<T> {
  private unavailable = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly filename: string, private readonly parse: (raw: unknown) => T) {}
  async read(): Promise<T | undefined> {
    await this.tail;
    if (this.unavailable) throw new Error('Settings publication is uncertain');
    try {return this.parse(JSON.parse(await readFile(join(this.directory, this.filename), 'utf8')));}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
  }
  write(value: T): Promise<void> {
    const safe = this.parse(value);
    const job = this.tail.then(async () => {
      if (this.unavailable) throw new Error('Settings publication is uncertain');
      await mkdir(this.directory, {recursive: true, mode: 0o700});
      const temp = join(this.directory, `${this.filename}.${randomUUID()}.tmp`);
      let publishing = false;
      try {
        const file = await open(temp, 'wx', 0o600);
        try {await file.writeFile(JSON.stringify(safe) + '\n'); await file.sync();} finally {await file.close();}
        publishing = true;
        await rename(temp, join(this.directory, this.filename));
        const directory = await open(this.directory, 'r');
        try {await directory.sync();} finally {await directory.close();}
      } catch (error) {
        if (publishing) this.unavailable = true;
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
}
