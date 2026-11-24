import { NextResponse } from '../../../../lib/next-server';
import * as Sentry from '../../../../lib/monitoring';
import { runMonthlyReconciliation } from '../../../../lib/jobs/monthly-reconciliation';

/** GET /api/cron/monthly-reconciliation[?period=YYYY-MM] — default: the WAT month that just ended. */
export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
  }

  const period = new URL(request.url).searchParams.get('period') ?? undefined;
  try {
    const result = await runMonthlyReconciliation(period);
    return NextResponse.json({ success: true, message: `Monthly reconciliation ${result.passed ? 'passed' : 'FAILED'}`, result });
  } catch (error: any) {
    Sentry.captureException(error, { tags: { cron: 'monthly-reconciliation' } });
    return NextResponse.json({ success: false, message: 'Failed to run monthly reconciliation' }, { status: 500 });
  }
}
