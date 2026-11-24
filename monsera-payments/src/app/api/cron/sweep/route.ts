import { NextResponse } from '../../../../lib/next-server';
import * as Sentry from '../../../../lib/monitoring';
import { runDailySweep } from '../../../../lib/jobs/daily-sweep';

export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runDailySweep();
    return NextResponse.json({ success: true, message: 'Daily sweep completed', result });
  } catch (error: any) {
    Sentry.captureException(error, { tags: { cron: 'sweep' } });
    return NextResponse.json({ success: false, message: 'Failed to run sweep job' }, { status: 500 });
  }
}