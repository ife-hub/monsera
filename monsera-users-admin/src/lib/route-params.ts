/**
 * Next.js 15+ passes dynamic route params as a Promise (in Next 16 the
 * synchronous fallback is gone), so `context.params.id` is undefined.
 * Always resolve through this helper.
 */
export async function getRouteId(context: { params?: any } | undefined): Promise<number> {
  const params = await context?.params;
  return Number(params?.id);
}
