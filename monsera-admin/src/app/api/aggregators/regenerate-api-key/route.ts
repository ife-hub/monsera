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
 * POST /api/aggregators/regenerate-api-key
 * Only AGGREGATOR users can regenerate their own API key
 */
async function postHandler(request: AuthenticatedRequest) {
  try {
    // Additional check - ensure user is an aggregator
    if (request.user?.userType !== UserType.AGGREGATOR) {
      return NextResponse.json(
        { success: false, message: 'Only aggregators can regenerate API keys' },
        { status: 403, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Find the aggregator associated with this user
    const aggregator = await prisma.aggregator.findUnique({
      where: { userId: request.user.userId },
    });

    if (!aggregator) {
      return NextResponse.json(
        { success: false, message: 'Aggregator not found' },
        { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Generate new API key
    const newApiKey = generateApiKey();

    // Update aggregator with new API key
    const updatedAggregator = await prisma.aggregator.update({
      where: { id: aggregator.id },
      data: { apiKey: newApiKey },
    });

    // Log the activity
    await prisma.audit.create({
      data: {
        userId: request.user.userId,
        employeeName: request.user.email,
        emailAddress: request.user.email,
        activity: `Regenerated API key for aggregator: ${aggregator.name}`,
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
// Only AGGREGATOR users can access this endpoint


/**
 * GET /api/aggregators/api-key
 * Only AGGREGATOR users can fetch their own API key
 */
async function getHandler(request: AuthenticatedRequest) {
  try {
    // Additional check - ensure user is an aggregator
    if (request.user?.userType !== UserType.AGGREGATOR) {
      return NextResponse.json(
        { success: false, message: 'Only aggregators can fetch API keys' },
        { status: 403, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Find the aggregator associated with this user
    const aggregator = await prisma.aggregator.findUnique({
      where: { userId: request.user.userId },
      select: {
        id: true,
        name: true,
        apiKey: true,
      },
    });

    if (!aggregator) {
      return NextResponse.json(
        { success: false, message: 'Aggregator not found' },
        { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Log the activity (optional)
    await prisma.audit.create({
      data: {
        userId: request.user.userId,
        employeeName: request.user.email,
        emailAddress: request.user.email,
        activity: `Fetched API key for aggregator: ${aggregator.name}`,
      },
    });

    return NextResponse.json(
      {
        success: true,
        message: 'API key fetched successfully',
        data: { 
          apiKey: aggregator.apiKey,
          aggregatorName: aggregator.name,
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
// Only AGGREGATOR users can access this endpoint
export const GET = authorize(UserType.AGGREGATOR)(getHandler);
export const POST = authorize(UserType.AGGREGATOR)(postHandler);