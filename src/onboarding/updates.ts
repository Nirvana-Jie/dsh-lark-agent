// Read only while the settings page polls, and at most this often once a check succeeds.
const CHECK_EVERY_MS = 6 * 60 * 60_000;
// A failed check (offline, blocked registry) waits this long before the next try.
const RETRY_AFTER_MS = 30 * 60_000;
const VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,40}))?$/;

/** True when `next` is a later release than `current`; a prerelease comes before its release. */
export function newerVersion(next: string, current: string): boolean {
  const a = VERSION.exec(next), b = VERSION.exec(current);
  if (!a || !b) return false;
  for (let index = 1; index <= 3; index++) {
    const left = Number(a[index]), right = Number(b[index]);
    if (left !== right) return left > right;
  }
  return !a[4] && Boolean(b[4]);
}

/** npm's `latest` tag for a package, when it names a stable release. Sends only the package name. */
export async function npmLatest(name: string, signal: AbortSignal): Promise<string | undefined> {
  const response = await fetch(`https://registry.npmjs.org/-/package/${name.replace('/', '%2f')}/dist-tags`,
    {signal, headers: {accept: 'application/json'}});
  if (!response.ok) return;
  const tags = await response.json() as {latest?: unknown} | null;
  const latest = tags?.latest;
  return typeof latest === 'string' && VERSION.test(latest) && !latest.includes('-') ? latest : undefined;
}

/**
 * Whether a newer release of this plugin is available, for the settings page.
 * A status read never waits for the registry: it returns what is known and
 * starts a background check when one is due. Failures just show no notice.
 */
export class UpdateCheck {
  private latest?: string;
  private nextCheck = 0;
  private running = false;

  constructor(private readonly current: string | undefined,
    private readonly lookup: (signal: AbortSignal) => Promise<string | undefined>,
    private readonly now: () => number = Date.now) {}

  status(): {current: string; latest: string} | undefined {
    if (!this.current || !VERSION.test(this.current)) return;
    if (!this.running && this.now() >= this.nextCheck) void this.refresh();
    return this.latest && newerVersion(this.latest, this.current) ? {current: this.current, latest: this.latest} : undefined;
  }

  private async refresh(): Promise<void> {
    this.running = true;
    this.nextCheck = this.now() + RETRY_AFTER_MS;
    try {
      const latest = await this.lookup(AbortSignal.timeout(10_000));
      if (latest && VERSION.test(latest)) {
        this.latest = latest;
        this.nextCheck = this.now() + CHECK_EVERY_MS;
      }
    } catch { /* Offline or blocked: no notice, and a later poll tries again. */ }
    finally { this.running = false; }
  }
}
