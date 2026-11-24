// lib/auth.ts
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { UserType } from '@prisma/client';

const DEV_FALLBACK_SECRET = 'dev-only-insecure-jwt-secret';
const JWT_EXPIRES_IN = '7d';

/**
 * Resolved lazily (not at import time) so `next build` can load route modules
 * without secrets present. In production a missing secret is a hard error —
 * never sign or accept tokens with a publicly known key.
 */
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is not set');
  }
  return DEV_FALLBACK_SECRET;
}

export interface JWTPayload {
  userId: number;
  email: string;
  userType: UserType;
  employeeId?: number;
  aggregatorId?: number;
  customerId?: number;
  roleId?: number;
}

export function generateToken(payload: JWTPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): JWTPayload {
  const secret = getJwtSecret();
  try {
    const decoded = jwt.verify(token, secret);

    if (typeof decoded === 'string') {
      throw new Error('Invalid token format');
    }

    return decoded as JWTPayload;
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function comparePasswords(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
