import { NextResponse } from '../../../../lib/next-server';
import prisma from '../../../../lib/prisma';
import { authenticate, authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType } from '@prisma/client';
import crypto from 'crypto';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

// Generate a secure random API key
function generateApiKey(): string {
  const prefix = 'api_';
  const randomBytes = crypto.randomBytes(32).toString('base64')
    .replace(/\+/g, '')
    .replace(/\//g, '')
    .replace(/=/g, '')
    .substring(0, 48);
  return prefix + randomBytes;
}

/**
 * POST /api/discos/regenerate-api-key
 * Only DISCO_ADMIN users can regenerate their own API key
 */
async function postHandler(request: AuthenticatedRequest) {
  try {
    // Additional check - ensure user is a disco admin
    if (request.user?.userType !== UserType.DISCO_ADMIN) {
      return NextResponse.json(
        { success: false, message: 'Only disco admins can regenerate API keys' },
        { status: 403, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Find the disco admin associated with this user
    const discoAdmin = await prisma.discoAdmin.findUnique({
      where: { userId: request.user.userId },
    });

    if (!discoAdmin) {
      return NextResponse.json(
        { success: false, message: 'Disco admin not found' },
        { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Generate new API key
    const newApiKey = generateApiKey();

    // Update disco admin with new API key
    const updatedDiscoAdmin = await prisma.discoAdmin.update({
      where: { id: discoAdmin.id },
      data: { apiKey: newApiKey },
    });

    // Log the activity
    await prisma.audit.create({
      data: {
        userId: request.user.userId,
        employeeName: request.user.email,
        emailAddress: request.user.email,
        activity: `Regenerated API key for disco admin: ${discoAdmin.name}`,
      },
    });

    return NextResponse.json(
      {
        success: true,
        message: 'API key regenerated successfully',
        data: { apiKey: newApiKey },
      },
      { headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error) {
    console.error('Regenerate API key error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to regenerate API key' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

// Apply authentication and authorization middleware
// Only DISCO_ADMIN users can access this endpoint


/**
 * GET /api/discos/api-key
 * Only DISCO_ADMIN users can fetch their own API key
 */
async function getHandler(request: AuthenticatedRequest) {
  try {
    // Additional check - ensure user is a disco admin
    if (request.user?.userType !== UserType.DISCO_ADMIN) {
      return NextResponse.json(
        { success: false, message: 'Only disco admins can fetch API keys' },
        { status: 403, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Find the disco admin associated with this user
    const discoAdmin = await prisma.discoAdmin.findUnique({
      where: { userId: request.user.userId },
      select: {
        id: true,
        name: true,
        apiKey: true,
      },
    });

    if (!discoAdmin) {
      return NextResponse.json(
        { success: false, message: 'Disco admin not found' },
        { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Log the activity (optional)
    await prisma.audit.create({
      data: {
        userId: request.user.userId,
        employeeName: request.user.email,
        emailAddress: request.user.email,
        activity: `Fetched API key for disco admin: ${discoAdmin.name}`,
      },
    });

    return NextResponse.json(
      {
        success: true,
        message: 'API key fetched successfully',
        data: { 
          apiKey: discoAdmin.apiKey,
          discoAdminName: discoAdmin.name,
        },
      },
      { headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error) {
    console.error('Fetch API key error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to fetch API key' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

// Apply authentication and authorization middleware
// Only DISCO_ADMIN users can access this endpoint
export const GET = authorize(UserType.DISCO_ADMIN)(getHandler);
export const POST = authorize(UserType.DISCO_ADMIN)(postHandler);