import { NextResponse } from '../../../../lib/next-server';
import * as Sentry from '../../../../lib/monitoring';
import { runReconciliation } from '../../../../lib/jobs/reconciliation';

export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
  }

  try {
    // ?day=YYYY-MM-DD (WAT) re-runs a past day; default is the day that just ended.
    const day = new URL(request.url).searchParams.get('day') ?? undefined;
    const result = await runReconciliation(day);
    return NextResponse.json({ success: true, message: 'Reconciliation completed', result });
  } catch (error: any) {
    Sentry.captureException(error, { tags: { cron: 'reconciliation' } });
    return NextResponse.json({ success: false, message: 'Failed to run reconciliation job' }, { status: 500 });
  }
}