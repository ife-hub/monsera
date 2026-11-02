import { UserType } from '@prisma/client';

export interface JwtPayload {
  userId: number;
  userType: UserType;
  email: string;
  roleId?: number;
}