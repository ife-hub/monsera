import { staffOrSelf } from '../../../../lib/record-access';
import { NextResponse } from '../../../../lib/next-server';
import { getRouteId } from '../../../../lib/route-params';
import { safeUserSelect, safeAggregatorSelect, safeDiscoSelect } from '../../../../lib/safe-select';
import prisma from '../../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

async function getHandler(request: AuthenticatedRequest,
  context: { params: Promise<{ id: string }> | { id: string }}) 
{
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  const aggregator = await prisma.aggregator.findUnique({ where: { id }, select: { ...safeAggregatorSelect, user: { select: safeUserSelect } } });
  if (!aggregator) return NextResponse.json({ success: false, message: 'Aggregator not found' }, { status: 404, headers: getCorsHeaders(request.headers.get('origin')) });

  return NextResponse.json({ success: true, data: aggregator }, { headers: getCorsHeaders(request.headers.get('origin')) });
}

async function putHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  const { name, email, logoUrl, status, outstanding } = await request.json();

  try {
    const aggregator = await prisma.aggregator.update({
      where: { id },
      data: { ...(name && { name }), ...(email && { mail: email }), ...(logoUrl && { logoUrl }), ...(status && { status }), ...(outstanding !== undefined && { outstanding }) },
      select: safeAggregatorSelect,
    });

    if (aggregator.userId) await prisma.user.update({ where: { id: aggregator.userId }, data: { ...(name && { name }), ...(email && { email }) } });

    await prisma.audit.create({ data: { userId: request.user!.userId, employeeName: request.user!.email, emailAddress: request.user!.email, activity: `Updated aggregator ID ${id}` } });

    return NextResponse.json({ success: true, data: aggregator }, { headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error) {
    console.error('Update aggregator error:', error);
    return NextResponse.json({ success: false, message: 'Failed to update aggregator' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

async function deleteHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  try {
    const aggregator = await prisma.aggregator.delete({ where: { id }, select: safeAggregatorSelect });

    await prisma.audit.create({ data: { userId: request.user!.userId, employeeName: request.user!.email, emailAddress: request.user!.email, activity: `Deleted aggregator ID ${id}` } });

    return NextResponse.json({ success: true, message: 'Deleted successfully', data: aggregator }, { headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error) {
    console.error('Delete aggregator error:', error);
    return NextResponse.json({ success: false, message: 'Failed to delete aggregator' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

// A partner reads only its own record (lib/record-access.ts).
export const GET = authenticate(staffOrSelf('aggregator', getHandler));
export const PUT = authorize(UserType.MONSERA_ADMIN)(putHandler);
export const DELETE = authorize(UserType.MONSERA_ADMIN)(deleteHandler);