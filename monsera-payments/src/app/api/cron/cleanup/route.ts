import { NextResponse } from '../../../../lib/next-server';
import * as Sentry from '../../../../lib/monitoring';
import { runIdempotencyCleanup } from '../../../../lib/jobs/idempotency-cleanup';

export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runIdempotencyCleanup();
    return NextResponse.json({ success: true, message: 'Idempotency cleanup completed', result });
  } catch (error: any) {
    Sentry.captureException(error, { tags: { cron: 'cleanup' } });
    return NextResponse.json({ success: false, message: 'Failed to run cleanup job' }, { status: 500 });
  }
}