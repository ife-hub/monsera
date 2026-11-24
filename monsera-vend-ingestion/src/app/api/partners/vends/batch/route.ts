import { NextResponse } from '../../../../../lib/next-server';
import prisma from '../../../../../lib/prisma';
import { authorize, AuthenticatedRequest } from '../../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { ingestVends } from '../../../../../lib/vend/ingest';
import { handleOptions, getCorsHeaders } from '../../../../../lib/cors';
import * as Sentry from "../../../../../lib/monitoring";

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

async function handler(request: AuthenticatedRequest) {
  const corsHeaders = getCorsHeaders(request.headers.get('origin'));

  try {
    const apiKey = request.headers.get('API-Key');
    const discoAdmin = await prisma.discoAdmin.findUnique({ where: { userId: request.user!.userId } });

    // Require a key on both sides: a disco with no key set must not match a request with no header.
    if (!apiKey || !discoAdmin || !discoAdmin.apiKey || discoAdmin.apiKey !== apiKey) {
      return NextResponse.json({ success: false, message: 'Invalid API key' }, { status: 403, headers: corsHeaders });
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, message: 'Request body must be valid JSON' }, { status: 400, headers: corsHeaders });
    }

    const { vends } = body ?? {};
    if (!Array.isArray(vends) || vends.length === 0) {
      return NextResponse.json({ success: false, message: 'vends must be a non-empty array' }, { status: 400, headers: corsHeaders });
    }

    const MAX_BATCH_SIZE = 500;
    if (vends.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { success: false, message: `Batch size exceeds maximum of ${MAX_BATCH_SIZE} vends per request` },
        { status: 400, headers: corsHeaders }
      );
    }

    const { results } = await ingestVends(discoAdmin.id, vends);
    const failed = results.filter((r) => r.status === 'rejected').length;

    return NextResponse.json(
      { success: true, processed: results.length - failed, failed, results },
      { status: 201, headers: corsHeaders }
    );
  } catch (error: any) {
    Sentry.captureException(error);
    console.error('Vend batch ingestion error:', error);
    return NextResponse.json({ success: false, message: 'Failed to process vend batch' }, { status: 500, headers: corsHeaders });
  }
}

/**
 * @swagger
 * /api/partners/vends/batch:
 *   post:
 *     summary: Ingest a batch of vend events from a disco
 *     description: >
 *       Accepts 1 to 500 vend records in a single request. Requires both a bearer token and an
 *       API-Key header matching the authenticated disco admin's stored key.
 *
 *
 *       **Per-item results.** Once the request is well-formed, the endpoint returns HTTP 201
 *       even if some or all vends are rejected. Check `failed` and each entry in `results`.
 *       `results` is in the same order as the submitted `vends`.
 *
 *
 *       **Duplicates and resends.** A partnerVendId that appears more than once in the same
 *       batch is rejected for every occurrence after the first. If a vend with the same
 *       partnerVendId and meterToken already exists, it is updated and returned as `accepted`,
 *       and its processing status is reset to pending, even if no values changed. If the
 *       partnerVendId exists for a different meterToken, that vend is rejected.
 *
 *
 *       Rejected vends with reason "Internal error processing this vend" can be resent safely.
 *     tags: [Vends]
 *     security:
 *       - bearerAuth: []
 *         apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vends]
 *             properties:
 *               vends:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 500
 *                 items:
 *                   $ref: '#/components/schemas/VendPayload'
 *     responses:
 *       201:
 *         description: Batch processed; see `results` for per-vend outcomes.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 processed:
 *                   type: integer
 *                   description: Number of vends accepted.
 *                 failed:
 *                   type: integer
 *                   description: Number of vends rejected.
 *                 results:
 *                   type: array
 *                   description: One entry per submitted vend, in request order.
 *                   items:
 *                     $ref: '#/components/schemas/VendResult'
 *       400:
 *         description: Body is not valid JSON, `vends` is missing, not an array or empty, or the batch exceeds 500 items.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Missing or invalid bearer token.
 *       403:
 *         description: Invalid API key, or the authenticated user is not a disco admin.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Unexpected server error. Some vends in the batch may already have been saved, so resend the batch (resends are safe).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
export const POST = authorize(UserType.DISCO_ADMIN)(handler);