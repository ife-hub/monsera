import { NextResponse } from '../../../lib/next-server';
import { invalidateSettings } from '../../../lib/settings-cache';
import prisma from '../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../middleware/auth';
import { TariffBand, UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../lib/cors';
import { DEFAULT_DAILY_CONSUMPTION_KOBO, dailyRateKobo } from '../../../lib/recovery-window';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/** GET — daily burn rate in force per band (§5.1), plus the full history. */
async function getHandler(request: AuthenticatedRequest) {
  const headers = getCorsHeaders(request.headers.get('origin'));
  const rows = await prisma.burnRate.findMany({ orderBy: { effectiveFrom: 'desc' } });
  const now = new Date();
  const current = Object.fromEntries(
    (Object.keys(DEFAULT_DAILY_CONSUMPTION_KOBO) as TariffBand[]).map((band) => [band, dailyRateKobo(band, rows, now) / 100])
  );
  return NextResponse.json({ success: true, data: { currentDailyBurnNaira: current, history: rows } }, { headers });
}

/** POST — body { band: 'A'|'B'|'C', dailyBurnNaira: number, effectiveFrom?: ISO } (monthly recalibration). */
async function postHandler(request: AuthenticatedRequest) {
  const headers = getCorsHeaders(request.headers.get('origin'));
  const { band, dailyBurnNaira, effectiveFrom } = (await request.json().catch(() => null)) ?? {};
  if (!Object.values(TariffBand).includes(band)) {
    return NextResponse.json({ success: false, message: 'band must be A, B or C' }, { status: 400, headers });
  }
  if (!Number.isInteger(dailyBurnNaira) || dailyBurnNaira <= 0) {
    return NextResponse.json({ success: false, message: 'dailyBurnNaira must be a positive whole number of naira' }, { status: 400, headers });
  }
  const from = effectiveFrom ? new Date(effectiveFrom) : new Date();
  if (Number.isNaN(from.getTime())) {
    return NextResponse.json({ success: false, message: 'effectiveFrom must be an ISO-8601 timestamp' }, { status: 400, headers });
  }

  const row = await prisma.burnRate.create({ data: { band, dailyBurnNaira, effectiveFrom: from } });
  invalidateSettings('burn-rates:'); // this instance at once; others within SETTINGS_CACHE_MS
  await prisma.audit.create({
    data: {
      userId: request.user!.userId,
      employeeName: request.user!.email,
      emailAddress: request.user!.email,
      activity: `Burn rate band ${band} set to ₦${dailyBurnNaira}/day effective ${from.toISOString()}`,
    },
  });
  return NextResponse.json({ success: true, data: row }, { status: 201, headers });
}

export const GET = authenticate(getHandler);
export const POST = authorize(UserType.MONSERA_ADMIN)(postHandler);
