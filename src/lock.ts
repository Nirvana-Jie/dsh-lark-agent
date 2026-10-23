import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Deliberately does not remove stale locks: a second process must never guess ownership. */
export async function acquireLock(stateDir: string): Promise<() => Promise<void>> {
  await mkdir(stateDir, {recursive: true, mode: 0o700});
  const path = join(stateDir, 'instance.lock');
  try { await mkdir(path, {mode: 0o700}); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Bot state directory is locked. Stop the previous instance; remove a stale instance.lock only after verifying it has exited.');
    throw error;
  }
  try { await writeFile(join(path, 'pid'), String(process.pid), {mode: 0o600}); }
  catch (error) { await rm(path, {recursive: true, force: true}); throw error; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rm(path, {recursive: true, force: true});
  };
}
