/**
 * Delivery stub. Replace with an actual email/webhook call once the
 * Notifications service (or an email provider) is wired up.
 */
export async function sendFailureReport(
  disco: { id: number; name: string; mail: string },
  failures: Array<{ id: number; partnerVendId: string | null; reason: string; createdAt: Date }>
): Promise<void> {
  // TODO: wire up actual delivery (email via disco.mail, or a webhook call)
  console.log(`[vend-failure-report] Would send ${failures.length} failures to ${disco.name} <${disco.mail}>`);
}