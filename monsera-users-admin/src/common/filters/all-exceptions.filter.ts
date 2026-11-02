import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node'; // swap for your actual Sentry init if different

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).json(typeof body === 'string' ? { success: false, message: body } : body);
      return;
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2002') {
      // Idempotency key race — the loser of a concurrent request. Same
      // behavior as the current Next.js routes: surfaces as a 500 rather
      // than a friendly replay, pending the conflict-resolution work
      // flagged earlier in this build.
      Sentry.captureException(exception);
      response.status(500).json({ success: false, message: 'Failed to process request due to a concurrent write', error: exception.message });
      return;
    }

    Sentry.captureException(exception);
    console.error('Unhandled exception:', exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ success: false, message: 'Internal server error' });
  }
}