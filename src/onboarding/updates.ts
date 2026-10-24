// Read only while the settings page polls, and at most this often once a check succeeds.
const CHECK_EVERY_MS = 6 * 60 * 60_000;
// A failed check (offline, blocked registry) waits this long before the next try.
const RETRY_AFTER_MS = 30 * 60_000;
// pnpm 11, which the App and `dsh plugin` install with, skips releases younger than a day
// (`minimumReleaseAge`) and installs an older one instead, so a release is offered only after that.
const INSTALLABLE_AFTER_MS = 24 * 60 * 60_000;
const VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,40}))?$/;

/** A published release and when npm says it was published (epoch milliseconds). */
export interface Release {
  version: string;
  publishedAt: number;
}

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

/**
 * npm's `latest` release of a package and its publish time, when it names a stable release.
 * Only the full package document carries publish times. Sends only the package name.
 */
export async function npmLatest(name: string, signal: AbortSignal): Promise<Release | undefined> {
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`,
    {signal, headers: {accept: 'application/json'}});
  if (!response.ok) return;
  const document = await response.json() as {'dist-tags'?: {latest?: unknown}; time?: unknown} | null;
  const latest = document?.['dist-tags']?.latest;
  if (typeof latest !== 'string' || !VERSION.test(latest) || latest.includes('-')) return;
  const time = document?.time;
  const stamp = time && typeof time === 'object' ? (time as Record<string, unknown>)[latest] : undefined;
  const publishedAt = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN;
  return Number.isFinite(publishedAt) ? {version: latest, publishedAt} : undefined;
}

/**
 * Whether a newer release of this plugin is available, for the settings page.
 * A status read never waits for the registry: it returns what is known and
 * starts a background check when one is due. Failures just show no notice.
 * A release younger than a day is not offered yet, since installing it would
 * still pick an older one; it shows up once it ages, without another check.
 */
export class UpdateCheck {
  private latest?: Release;
  private nextCheck = 0;
  private running = false;

  constructor(private readonly current: string | undefined,
    private readonly lookup: (signal: AbortSignal) => Promise<Release | undefined>,
    private readonly now: () => number = Date.now) {}

  status(): {current: string; latest: string} | undefined {
    if (!this.current || !VERSION.test(this.current)) return;
    if (!this.running && this.now() >= this.nextCheck) void this.refresh();
    const latest = this.latest;
    if (!latest || this.now() - latest.publishedAt < INSTALLABLE_AFTER_MS) return;
    return newerVersion(latest.version, this.current) ? {current: this.current, latest: latest.version} : undefined;
  }

  private async refresh(): Promise<void> {
    this.running = true;
    this.nextCheck = this.now() + RETRY_AFTER_MS;
    try {
      const latest = await this.lookup(AbortSignal.timeout(10_000));
      if (latest && VERSION.test(latest.version) && Number.isFinite(latest.publishedAt)) {
        this.latest = {version: latest.version, publishedAt: latest.publishedAt};
        this.nextCheck = this.now() + CHECK_EVERY_MS;
      }
    } catch { /* Offline or blocked: no notice, and a later poll tries again. */ }
    finally { this.running = false; }
  }
}
