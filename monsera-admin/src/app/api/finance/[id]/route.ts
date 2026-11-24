import { staffOrSelf } from '../../../../lib/record-access';
import { NextResponse } from '../../../../lib/next-server';
import { getRouteId } from '../../../../lib/route-params';
import { safeUserSelect } from '../../../../lib/safe-select';
import prisma from '../../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

async function getHandler(request: AuthenticatedRequest,
  context: { params: Promise<{ id: string }> })
{
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  const financeHouse = await prisma.financeHouse.findUnique({ where: { id }, include: { user: { select: safeUserSelect } } });
  if (!financeHouse) return NextResponse.json({ success: false, message: 'Finance house not found' }, { status: 404, headers: getCorsHeaders(request.headers.get('origin')) });

  return NextResponse.json({ success: true, data: financeHouse  }, { headers: getCorsHeaders(request.headers.get('origin')) });
}

async function forbidUnlessOwnerOrAdmin(request: AuthenticatedRequest, financeHouseId: number) {
  if (request.user!.userType === UserType.MONSERA_ADMIN) return null;
  const own = await prisma.financeHouse.findUnique({ where: { userId: request.user!.userId }, select: { id: true } });
  if (!own || own.id !== financeHouseId) {
    return NextResponse.json({ success: false, message: 'You can only manage your own finance house' }, { status: 403, headers: getCorsHeaders(request.headers.get('origin')) });
  }
  return null;
}

async function putHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  const denied = await forbidUnlessOwnerOrAdmin(request, id);
  if (denied) return denied;

  // FinanceHouse has no `outstanding` column — passing it made every update fail.
  const { name, email, logoUrl, status } = await request.json();
  const isAdmin = request.user!.userType === UserType.MONSERA_ADMIN;

  try {
    const financeHouse = await prisma.financeHouse.update({
      where: { id },
      data: { ...(name && { name }), ...(email && { mail: email }), ...(logoUrl && { logoUrl }), ...(isAdmin && status && { status }) },
    });

    if (financeHouse.userId) await prisma.user.update({ where: { id: financeHouse.userId }, data: { ...(name && { name }), ...(email && { email }) } });

    await prisma.audit.create({ data: { userId: request.user!.userId, employeeName: request.user!.email, emailAddress: request.user!.email, activity: `Updated finance house ID ${id}` } });

    return NextResponse.json({ success: true, data: financeHouse }, { headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error) {
    console.error('Update finance house error:', error);
    return NextResponse.json({ success: false, message: 'Failed to update finance house' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

async function deleteHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  try {
    const financeHouse = await prisma.financeHouse.delete({ where: { id } });

    await prisma.audit.create({ data: { userId: request.user!.userId, employeeName: request.user!.email, emailAddress: request.user!.email, activity: `Deleted finance house ID ${id}` } });

    return NextResponse.json({ success: true, message: 'Deleted successfully', data: financeHouse }, { headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error) {
    console.error('Delete finance house error:', error);
    return NextResponse.json({ success: false, message: 'Failed to delete finance house' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

// A partner reads only its own record (lib/record-access.ts).
export const GET = authenticate(staffOrSelf('financeHouse', getHandler));
export const PUT = authorize(UserType.MONSERA_ADMIN, UserType.FINANCE_HOUSE)(putHandler);
export const DELETE = authorize(UserType.MONSERA_ADMIN)(deleteHandler);
