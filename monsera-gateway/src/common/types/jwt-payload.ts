export interface JwtPayload {
  userId: number;
  userType: string;
  email: string;
  roleId?: number;
}