import { staffOrSelf } from '../../../../lib/record-access';
import { NextResponse } from '../../../../lib/next-server';
import { getRouteId } from '../../../../lib/route-params';
import { safeUserSelect, safeDiscoSelect } from '../../../../lib/safe-select';
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

  const disco = await prisma.discoAdmin.findUnique({ where: { id }, select: { ...safeDiscoSelect, user: { select: safeUserSelect } } });
  if (!disco) return NextResponse.json({ success: false, message: 'Disco not found' }, { status: 404, headers: getCorsHeaders(request.headers.get('origin')) });

  return NextResponse.json({ success: true, data: disco }, { headers: getCorsHeaders(request.headers.get('origin')) });
}

/**
 * A disco admin may only act on their own disco record; a Monsera admin may
 * act on any. Returns an error response when the caller is not allowed.
 */
async function forbidUnlessOwnerOrAdmin(request: AuthenticatedRequest, discoId: number) {
  if (request.user!.userType === UserType.MONSERA_ADMIN) return null;
  const own = await prisma.discoAdmin.findUnique({ where: { userId: request.user!.userId }, select: { id: true } });
  if (!own || own.id !== discoId) {
    return NextResponse.json({ success: false, message: 'You can only manage your own disco' }, { status: 403, headers: getCorsHeaders(request.headers.get('origin')) });
  }
  return null;
}

async function putHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  const denied = await forbidUnlessOwnerOrAdmin(request, id);
  if (denied) return denied;

  const { name, email, logoUrl, status, outstanding } = await request.json();
  const isAdmin = request.user!.userType === UserType.MONSERA_ADMIN;

  try {
    const disco = await prisma.discoAdmin.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(email && { mail: email }),
        ...(logoUrl && { logoUrl }),
        // Account status and the outstanding balance are ledger/governance
        // fields — only Monsera may change them, never the disco itself.
        ...(isAdmin && status && { status }),
        ...(isAdmin && outstanding !== undefined && { outstanding }),
      },
      select: safeDiscoSelect,
    });

    if (disco.userId) await prisma.user.update({ where: { id: disco.userId }, data: { ...(name && { name }), ...(email && { email }) } });

    await prisma.audit.create({ data: { userId: request.user!.userId, employeeName: request.user!.email, emailAddress: request.user!.email, activity: `Updated disco admin ID ${id}` } });

    return NextResponse.json({ success: true, data: disco }, { headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error) {
    console.error('Update disco admin error:', error);
    return NextResponse.json({ success: false, message: 'Failed to update disco admin' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

async function deleteHandler(request: AuthenticatedRequest, context: { params: Promise<{ id: string }> }) {
  const id = await getRouteId(context);
  if (isNaN(id)) return NextResponse.json({ success: false, message: 'Invalid ID' }, { status: 400, headers: getCorsHeaders(request.headers.get('origin')) });

  try {
    const disco = await prisma.discoAdmin.delete({ where: { id }, select: safeDiscoSelect });

    await prisma.audit.create({ data: { userId: request.user!.userId, employeeName: request.user!.email, emailAddress: request.user!.email, activity: `Deleted disco admin ID ${id}` } });

    return NextResponse.json({ success: true, message: 'Deleted successfully', data: disco }, { headers: getCorsHeaders(request.headers.get('origin')) });
  } catch (error) {
    console.error('Delete disco admin error:', error);
    return NextResponse.json({ success: false, message: 'Failed to delete disco admin' }, { status: 500, headers: getCorsHeaders(request.headers.get('origin')) });
  }
}

// A partner reads only its own record (lib/record-access.ts).
export const GET = authenticate(staffOrSelf('disco', getHandler));
export const PUT = authorize(UserType.MONSERA_ADMIN, UserType.DISCO_ADMIN)(putHandler);
// Deleting a disco removes a counterparty from the ledger — Monsera only.
export const DELETE = authorize(UserType.MONSERA_ADMIN)(deleteHandler);
