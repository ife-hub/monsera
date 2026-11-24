import { NextResponse } from '../../../../lib/next-server';
import * as Sentry from '../../../../lib/monitoring';
import { runObligationStatusSweep } from '../../../../lib/jobs/obligation-status-sweep';

export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runObligationStatusSweep();
    return NextResponse.json({ success: true, message: 'Obligation status sweep completed', result });
  } catch (error: any) {
    Sentry.captureException(error, { tags: { cron: 'obligation-status' } });
    return NextResponse.json({ success: false, message: 'Failed to run obligation status job' }, { status: 500 });
  }
}