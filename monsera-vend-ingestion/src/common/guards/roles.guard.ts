import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserType } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowedTypes = this.reflector.getAllAndOverride<UserType[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowedTypes || allowedTypes.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user || !allowedTypes.includes(user.userType)) {
      throw new ForbiddenException({ success: false, message: 'Insufficient permissions' });
    }
    return true;
  }
}