/**
 * Delivers a disco's vend failure report through monsera-notifications
 * (POST /notifications/vend-failure-report, authenticated with the shared
 * INTERNAL_API_KEY). Throws if delivery fails, so the caller leaves the
 * failures unreported and they go out with the next report.
 */
export interface FailureReportItem {
  id: number;
  submittedPartnerVendId: string | null;
  reason: string;
  createdAt: Date;
}

/** The notifications endpoint accepts at most this many failures per call. */
export const MAX_FAILURES_PER_REPORT = 5000;

export async function sendFailureReport(disco: { id: number; name: string; mail: string }, failures: FailureReportItem[]): Promise<void> {
  const baseUrl = process.env.NOTIFICATIONS_URL;
  const key = process.env.INTERNAL_API_KEY;
  if (!baseUrl || !key) throw new Error('NOTIFICATIONS_URL and INTERNAL_API_KEY must be set to send vend failure reports');

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/notifications/vend-failure-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': key },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      discoName: disco.name,
      discoEmail: disco.mail,
      failures: failures.map((f) => ({
        submittedPartnerVendId: f.submittedPartnerVendId,
        reason: f.reason.slice(0, 500),
        createdAt: f.createdAt.toISOString(),
      })),
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Notifications rejected the vend failure report for ${disco.name}: HTTP ${response.status} ${body.slice(0, 300)}`);
  }
}
