import { NextResponse } from '../../../../lib/next-server';
import * as Sentry from '../../../../lib/monitoring';
import { runSettlement } from '../../../../lib/jobs/settlement';

export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runSettlement();
    return NextResponse.json({ success: true, message: 'Settlement completed', result });
  } catch (error: any) {
    Sentry.captureException(error, { tags: { cron: 'settlement' } });
    return NextResponse.json({ success: false, message: 'Failed to run settlement job' }, { status: 500 });
  }
}