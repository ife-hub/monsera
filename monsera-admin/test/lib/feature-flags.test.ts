jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { featureFlag: { findUnique: jest.fn() } },
}));

import prisma from '@/lib/prisma';
import { isEnabled } from '@/lib/feature-flags';

const mockFindUnique = (prisma as any).featureFlag.findUnique as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('isEnabled defaults', () => {
  it('treats a missing maintenance_mode row as OFF (lending continues)', async () => {
    mockFindUnique.mockResolvedValue(null);
    expect(await isEnabled('maintenance_mode')).toBe(false);
  });

  it('treats missing *_enabled rows as ON', async () => {
    mockFindUnique.mockResolvedValue(null);
    expect(await isEnabled('disbursements_enabled')).toBe(true);
    expect(await isEnabled('credit_enabled')).toBe(true);
  });

  it('keeps normal behaviour when the database lookup fails', async () => {
    mockFindUnique.mockRejectedValue(new Error('connection reset'));
    expect(await isEnabled('maintenance_mode')).toBe(false);
    expect(await isEnabled('disbursements_enabled')).toBe(true);
  });

  it('uses the stored value when the row exists', async () => {
    mockFindUnique.mockResolvedValue({ key: 'maintenance_mode', enabled: true });
    expect(await isEnabled('maintenance_mode')).toBe(true);
  });
});
