import { cachedSetting, invalidateSettings } from '@/lib/settings-cache';

describe('settings cache', () => {
  beforeEach(() => {
    process.env.SETTINGS_CACHE_MS = '5000';
    invalidateSettings();
    jest.useRealTimers();
  });
  afterAll(() => {
    delete process.env.SETTINGS_CACHE_MS;
  });

  it('reads once, then serves the cached value until it expires', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-25T10:00:00Z') });
    const load = jest.fn().mockResolvedValueOnce('v1').mockResolvedValueOnce('v2');

    expect(await cachedSetting('k', load)).toBe('v1');
    expect(await cachedSetting('k', load)).toBe('v1');
    expect(load).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-11-25T10:00:06Z')); // past 5s
    expect(await cachedSetting('k', load)).toBe('v2');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one read between concurrent callers', async () => {
    let resolve!: (v: string) => void;
    const load = jest.fn(() => new Promise<string>((r) => (resolve = r)));
    const both = Promise.all([cachedSetting('k', load), cachedSetting('k', load)]);
    resolve('v');
    expect(await both).toEqual(['v', 'v']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never caches a failed read', async () => {
    const load = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce('v');
    await expect(cachedSetting('k', load)).rejects.toThrow('db down');
    expect(await cachedSetting('k', load)).toBe('v');
  });

  it('a saved change is visible at once on this instance after invalidation', async () => {
    const load = jest.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new');
    expect(await cachedSetting('flag:maintenance_mode', load)).toBe('old');
    invalidateSettings('flag:');
    expect(await cachedSetting('flag:maintenance_mode', load)).toBe('new');
  });

  it('SETTINGS_CACHE_MS=0 turns caching off', async () => {
    process.env.SETTINGS_CACHE_MS = '0';
    const load = jest.fn().mockResolvedValue('v');
    await cachedSetting('k', load);
    await cachedSetting('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
