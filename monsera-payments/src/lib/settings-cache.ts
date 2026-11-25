/**
 * Short-lived in-memory cache for settings that every advance reads but that
 * rarely change: feature flags, credit parameters, recovery-window
 * parameters and burn rates.
 *
 * Without it, each advance made six extra database round trips (and waited
 * for a pooled connection for each) just to re-read the same settings. With
 * it, a change to one of those settings takes effect within SETTINGS_CACHE_MS
 * (default 5000ms) on every payments instance, and immediately on the
 * instance that saved it (invalidateSettings).
 *
 *  - A failed read is not cached, so the next call tries the database again.
 *  - Concurrent callers share one in-flight read.
 *  - Off in tests (NODE_ENV=test) unless SETTINGS_CACHE_MS is set, so tests
 *    that change settings between cases always see the new values.
 */
const entries = new Map<string, { value?: unknown; expires: number; pending?: Promise<unknown> }>();

const ttlMs = () => {
  const configured = process.env.SETTINGS_CACHE_MS;
  if (configured !== undefined) return Math.max(0, Number(configured) || 0);
  return process.env.NODE_ENV === 'test' ? 0 : 5000;
};

export async function cachedSetting<T>(key: string, load: () => Promise<T>): Promise<T> {
  const ttl = ttlMs();
  if (ttl === 0) return load();

  const now = Date.now();
  const hit = entries.get(key);
  if (hit && hit.expires > now && 'value' in hit) return hit.value as T;
  if (hit?.pending) return hit.pending as Promise<T>;

  const pending = load().then(
    (value) => {
      entries.set(key, { value, expires: Date.now() + ttl });
      return value;
    },
    (error) => {
      entries.delete(key); // never cache a failure
      throw error;
    }
  );
  entries.set(key, { expires: 0, pending });
  return pending;
}

/** Drops cached settings (all, or those whose key starts with `prefix`). */
export function invalidateSettings(prefix?: string) {
  if (!prefix) return entries.clear();
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
}
