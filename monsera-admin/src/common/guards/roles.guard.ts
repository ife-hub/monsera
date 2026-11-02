import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserType } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowedTypes = this.reflector.getAllAndOverride<UserType[]>(
      ROLES_KEY,
      [
        context.getHandler(),
        context.getClass(),
      ],
    );

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    this.logger.debug('========== RolesGuard ==========');

    this.logger.debug(`Method: ${request.method}`);
    this.logger.debug(`URL: ${request.originalUrl || request.url}`);

    this.logger.debug(
      `Allowed user types: ${JSON.stringify(allowedTypes)}`,
    );

    this.logger.debug(
      `Authenticated user: ${JSON.stringify(user)}`,
    );

    if (!allowedTypes || allowedTypes.length === 0) {
      this.logger.debug('No roles specified. Access GRANTED.');
      return true;
    }

    if (!user) {
      this.logger.warn('Access DENIED: request.user is undefined.');
      throw new ForbiddenException({
        success: false,
        message: 'Insufficient permissions',
      });
    }

    this.logger.debug(`User ID: ${user.userId}`);
    this.logger.debug(`User email: ${user.email}`);
    this.logger.debug(`User type: ${user.userType}`);
    this.logger.debug(`User type typeof: ${typeof user.userType}`);

    this.logger.debug(
      `Allowed types typeof: ${allowedTypes.map(type => typeof type).join(', ')}`,
    );

    const hasPermission = allowedTypes.includes(user.userType);

    this.logger.debug(
      `Permission check: ${JSON.stringify({
        userType: user.userType,
        allowedTypes,
        hasPermission,
      })}`,
    );

    if (!hasPermission) {
      this.logger.warn(
        `Access DENIED for user ${user.email}. ` +
        `UserType: "${user.userType}", ` +
        `AllowedTypes: ${JSON.stringify(allowedTypes)}`,
      );

      throw new ForbiddenException({
        success: false,
        message: 'Insufficient permissions',
      });
    }

    this.logger.debug('Access GRANTED.');
    this.logger.debug('================================');

    return true;
  }
}