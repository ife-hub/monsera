import prisma from './prisma';
import { cachedSetting, invalidateSettings } from './settings-cache';

export type FlagKey =
  | 'disbursements_enabled'
  | 'scoring_engine_enabled'
  | 'recovery_enabled'
  | 'maintenance_mode'
  | 'credit_enabled';

/**
 * Value used when a flag has no row in the database, or the lookup fails.
 *
 * The default must be the value that keeps the system running normally.
 * For "*_enabled" flags that is `true`, but `maintenance_mode` is inverted:
 * `true` there means "stop lending". A single "unknown = true" default used
 * to put every environment without a maintenance_mode row — and every
 * environment during a database blip — into maintenance mode, returning 503
 * on every advance.
 */
export const FLAG_DEFAULTS: Record<FlagKey, boolean> = {
  disbursements_enabled: true,
  scoring_engine_enabled: true,
  recovery_enabled: true,
  credit_enabled: true,
  maintenance_mode: false,
};

/**
 * Check whether a feature flag is enabled. Falls back to FLAG_DEFAULTS when
 * the flag does not exist or the database is unavailable, so a missing row or
 * a DB outage never changes normal behaviour.
 */
export async function isEnabled(key: FlagKey): Promise<boolean> {
  try {
    // Cached for a few seconds (lib/settings-cache.ts); a change takes effect within SETTINGS_CACHE_MS.
    const flag = await cachedSetting(`flag:${key}`, () => prisma.featureFlag.findUnique({ where: { key } }));
    if (!flag) return FLAG_DEFAULTS[key];
    return flag.enabled;
  } catch (error) {
    console.error(`Feature flag check failed for key '${key}':`, error);
    return FLAG_DEFAULTS[key];
  }
}

/**
 * Set a feature flag. Records who changed it and when.
 */
export async function setFlag(
  key: FlagKey,
  enabled: boolean,
  updatedBy: string
): Promise<void> {
  await prisma.featureFlag.upsert({
    where: { key },
    update: { enabled, updatedBy },
    create: {
      key,
      enabled,
      updatedBy,
      description: `Auto-created flag for ${key}`,
    },
  });
  invalidateSettings('flag:');
}

/**
 * Get all flags — for the admin dashboard.
 */
export async function getAllFlags() {
  return prisma.featureFlag.findMany({
    orderBy: { key: 'asc' },
  });
}