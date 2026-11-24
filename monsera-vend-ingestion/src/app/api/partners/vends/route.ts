import { NextResponse } from '../../../../lib/next-server';
import prisma from '../../../../lib/prisma';
import { authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { ingestVends } from '../../../../lib/vend/ingest';
import { handleOptions, getCorsHeaders } from '../../../../lib/cors';
import * as Sentry from "../../../../lib/monitoring";

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

    let vend: any;
    try {
      vend = await request.json();
    } catch {
      return NextResponse.json({ success: false, message: 'Request body must be valid JSON' }, { status: 400, headers: corsHeaders });
    }

    const { results } = await ingestVends(discoAdmin.id, [vend]);
    const [result] = results;

    return NextResponse.json(
      { success: result.status === 'accepted', result },
      { status: result.status === 'accepted' ? 201 : 400, headers: corsHeaders }
    );
  } catch (error: any) {
    Sentry.captureException(error);
    console.error('Vend ingestion error:', error);
    return NextResponse.json({ success: false, message: 'Failed to process vend' }, { status: 500, headers: corsHeaders });
  }
}

/**
 * @swagger
 * components:
 *   schemas:
 *     VendPayload:
 *       type: object
 *       required: [partnerVendId, meterToken, amountKobo, vendType, vendStatus, vendedAt]
 *       additionalProperties: false
 *       description: >
 *         Any field not listed here causes the vend to be rejected with
 *         "Unrecognized field(s): ...".
 *       properties:
 *         partnerVendId:
 *           type: string
 *           pattern: '^[A-Za-z0-9_-]{1,100}$'
 *           minLength: 1
 *           maxLength: 100
 *           description: >
 *             Your unique ID for this vend. Unique per disco admin. Resending an existing ID with
 *             the same meterToken updates the existing record (see "Resends" on the endpoint).
 *           example: ABP-9920
 *         meterToken:
 *           type: string
 *           minLength: 1
 *           maxLength: 100
 *           example: MT-001
 *         amountKobo:
 *           type: integer
 *           minimum: 1
 *           description: Amount in kobo (must be a positive integer).
 *           example: 5000
 *         vendType:
 *           type: string
 *           description: 'Vend Type (Any of PREPAID_TOKEN, POSTPAID_PAYMENT, TOKEN_TOP_UP)'
 *           enum: [PREPAID_TOKEN, POSTPAID_PAYMENT, TOKEN_TOP_UP]
 *         vendStatus:
 *           type: string
 *           description: 'Vend Status (Any of SUCCESSFUL, FAILED)'
 *           enum: [SUCCESSFUL, FAILED]
 *         vendedAt:
 *           type: string
 *           format: date-time
 *           description: >
 *             ISO 8601 timestamp of the vend. Send it with an explicit timezone
 *             (e.g. "2026-03-01T10:00:00.000Z" or "2026-03-01T11:00:00+01:00"). Values without a
 *             timezone are interpreted in the server's local time.
 *           example: '2026-03-01T10:00:00.000Z'
 *     VendResult:
 *       type: object
 *       required: [partnerVendId, status]
 *       properties:
 *         partnerVendId:
 *           type: string
 *           description: >
 *             Echo of the submitted partnerVendId. If the submitted value was missing or invalid,
 *             this can be "(missing)" or the submitted value truncated to 200 characters.
 *           example: ABP-9920
 *         status:
 *           type: string
 *           enum: [accepted, rejected]
 *         reason:
 *           type: string
 *           nullable: true
 *           description: >
 *             Present when status is "rejected". Possible values include field validation
 *             messages (e.g. "amountKobo is required and must be a positive integer",
 *             "Unrecognized field(s): foo"), "Each vend must be a JSON object",
 *             "duplicate partnerVendId within this batch",
 *             "partnerVendId already exists for a different meterToken", and
 *             "Internal error processing this vend" (a server-side failure; the same vend can
 *             be resent safely).
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           example: false
 *         message:
 *           type: string
 *           example: Request body must be valid JSON
 *
 * /api/partners/vends:
 *   post:
 *     summary: Ingest a single vend event from a disco
 *     description: >
 *       Accepts a vend record from a disco admin's system for processing. Requires both a bearer
 *       token and an API-Key header matching the authenticated disco admin's stored key.
 *
 *
 *       **Resends (idempotency).** If a vend with the same partnerVendId and the same meterToken
 *       already exists, it is updated with the submitted values and returned as `accepted`, and
 *       its processing status is reset to pending, even if no values changed. If the
 *       partnerVendId exists for a different meterToken, the vend is rejected.
 *
 *
 *       **Rejections.** Validation and business-rule failures return HTTP 400 with the rejected
 *       `result`. A vend that fails because of an internal error is also currently returned as
 *       HTTP 400 with reason "Internal error processing this vend"; it can be resent safely.
 *     tags: [Vends]
 *     security:
 *       - bearerAuth: []
 *         apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/VendPayload'
 *     responses:
 *       201:
 *         description: Vend accepted (new or updated).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 result:
 *                   $ref: '#/components/schemas/VendResult'
 *       400:
 *         description: >
 *           Vend rejected, or the request body was not valid JSON. A rejected vend returns
 *           `{ success, result }`; an invalid body returns `{ success, message }`.
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   properties:
 *                     success:
 *                       type: boolean
 *                       example: false
 *                     result:
 *                       $ref: '#/components/schemas/VendResult'
 *                 - $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Missing or invalid bearer token.
 *       403:
 *         description: Invalid API key, or the authenticated user is not a disco admin.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Unexpected server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
export const POST = authorize(UserType.DISCO_ADMIN)(handler);