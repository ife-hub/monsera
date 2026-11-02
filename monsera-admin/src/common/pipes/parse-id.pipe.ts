import { BadRequestException, ParseIntPipe } from '@nestjs/common';

export const parseIdPipe = new ParseIntPipe({
  exceptionFactory: () => new BadRequestException({ success: false, message: 'Invalid ID' }),
});