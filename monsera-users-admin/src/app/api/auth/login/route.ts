import { NextRequest, NextResponse } from '../../../../lib/next-server';
import prisma from '../../../../lib/prisma';
import { comparePasswords, generateToken } from '../../../../lib/auth';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';
import { checkLoginAllowed, recordLoginFailure, clearLoginFailures, clientIp } from '../../../../lib/rate-limit';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}


/**
 * Login endpoint
 */
/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Authenticate a user and receive a JWT
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 format: password
 *     responses:
 *       200:
 *         description: Login successful, returns a JWT and basic user info.
 *       400:
 *         description: Missing email or password.
 *       401:
 *         description: Invalid email or password.
 *       403:
 *         description: Account is inactive.
 *       429:
 *         description: >
 *           Too many failed attempts. Limits — 5 failures per email and 20 per
 *           client IP within 15 minutes (configurable). The Retry-After header
 *           gives the seconds until the window resets. Tokens expire after 7
 *           days; a password change or deactivation revokes earlier tokens.
 */
export async function POST(request: NextRequest) {
  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, message: 'Request body must be valid JSON' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }
    const { email, password } = body ?? {};

    if (!email || !password) {
      return NextResponse.json(
        { success: false, message: 'Email and password are required.' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    if (typeof email !== 'string' || typeof password !== 'string') {
      return NextResponse.json(
        { success: false, message: 'Email and password are required.' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Throttle repeated failures per email and per client IP (lib/rate-limit.ts).
    const ip = clientIp(request.headers);
    const limit = await checkLoginAllowed(email, ip);
    if (!limit.allowed) {
      return NextResponse.json(
        { success: false, message: 'Too many failed login attempts. Please try again later.' },
        {
          status: 429,
          headers: {
            ...getCorsHeaders(request.headers.get('origin')),
            'Retry-After': String(limit.retryAfterSeconds ?? 60),
          },
        }
      );
    }

    // Find user with relations
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        employee: { include: { role: true } },
        aggregator: true,
        systemAdmin: true,
        discoAdmin: true
      },
    });

    if (!user) {
      // Count unknown emails too, so the limiter can't be used to tell which
      // emails have accounts.
      await recordLoginFailure(email, ip);
      return NextResponse.json(
        { success: false, message: 'Invalid email or password.' },
        { status: 401, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Verify password
    const isValidPassword = await comparePasswords(password, user.passwordHash);

    if (!isValidPassword) {
      await recordLoginFailure(email, ip);
      return NextResponse.json(
        { success: false, message: 'Invalid email or password.' },
        { status: 401, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    if (!user.isActive) {
      return NextResponse.json(
        {
          success: false,
          message: 'Account is inactive. Please contact support.',
        },
        { status: 403, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    await clearLoginFailures(email);

    // Build JWT payload
    const tokenPayload: any = {
      userId: user.id,
      email: user.email,
      userType: user.userType,
    };

    if (user.employee) {
      tokenPayload.employeeId = user.employee.id;
      tokenPayload.roleId = user.employee.roleId;
    }


    const token = generateToken(tokenPayload);

    // Build response data
    const responseData: any = {
      id: user.id,
      email: user.email,
      name: user.name,
      userType: user.userType,
      isActive: user.isActive,
    };

    if (user.employee) {
      responseData.employee = {
        id: user.employee.id,
        role: user.employee.role,
      };
    }

        if (user.aggregator) {
  responseData.aggregator = {
    id: user.aggregator.id,
    name: user.aggregator.name,   // ✅ the aggregator name
  };
}

            if (user.discoAdmin) {
  responseData.discoAdmin = {
    id: user.discoAdmin.id,
    name: user.discoAdmin.name,   // ✅ the aggregator name
  };
}

    await prisma.audit.create({
      data: {
        userId: user.id,
        employeeName: user.name,
        emailAddress: user.email,
        activity: 'User logged in',
      },
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          user: responseData,
          token,
        },
      },
      { status: 200, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error) {
    console.error('Login error:', error);

    return NextResponse.json(
      { success: false, message: 'An error occurred during login.' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}
