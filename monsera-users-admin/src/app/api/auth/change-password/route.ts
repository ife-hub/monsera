import { authenticate, AuthenticatedRequest } from '../../../../middleware/auth';
import prisma from '../../../../lib/prisma';
import { comparePasswords, hashPassword, generateToken, JWTPayload } from '../../../../lib/auth';
import { NextResponse } from '../../../../lib/next-server';
import { getCorsHeaders, handleOptions } from '../../../../lib/cors';

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * Password validation
 */
function validatePassword(password: string): { valid: boolean; message?: string } {
  if (password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters long' };
  }
  
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one uppercase letter' };
  }
  
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one lowercase letter' };
  }
  
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one number' };
  }
  
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one special character' };
  }
  
  return { valid: true };
}

async function handler(request: AuthenticatedRequest) {
  try {
    const body = await request.json();
    const { currentPassword, newPassword } = body;

    // Validation
    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { success: false, message: 'Current password and new password are required' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Validate new password strength
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      return NextResponse.json(
        { success: false, message: passwordValidation.message },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Check if new password is same as current
    if (currentPassword === newPassword) {
      return NextResponse.json(
        { success: false, message: 'New password must be different from current password' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Get user from database
    const user = await prisma.user.findUnique({
      where: { id: request.user!.userId },
    });

    if (!user) {
      return NextResponse.json(
        { success: false, message: 'User not found' },
        { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Verify current password
    const isValidPassword = await comparePasswords(currentPassword, user.passwordHash);
    if (!isValidPassword) {
      return NextResponse.json(
        { success: false, message: 'Current password is incorrect' },
        { status: 401, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    // Hash new password
    const newPasswordHash = await hashPassword(newPassword);

    // Update password in database
    // passwordChangedAt invalidates every token issued before now, including
    // any session an attacker may hold. The caller gets a fresh token below.
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newPasswordHash, passwordChangedAt: new Date() },
    });

    // Re-issue the caller's token from the old claims so this session keeps working.
    const { iat, exp, ...claims } = request.user as JWTPayload & { iat?: number; exp?: number };
    const token = generateToken(claims as JWTPayload);

    // Create audit log
    await prisma.audit.create({
      data: {
        userId: user.id,
        employeeName: user.name,
        emailAddress: user.email,
        activity: 'Password changed',
      },
    });

    return NextResponse.json(
      {
        success: true,
        message: 'Password changed successfully. Other sessions have been signed out.',
        data: { token },
      },
      { status: 200, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  } catch (error) {
    console.error('Change password error:', error);
    return NextResponse.json(
      { success: false, message: 'An error occurred while changing password' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

export const POST = authenticate(handler);