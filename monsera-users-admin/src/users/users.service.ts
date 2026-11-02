import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findById(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, userType: true, isActive: true, createdAt: true },
    });
    if (!user) throw new NotFoundException({ success: false, message: 'User not found' });
    return { success: true, data: user };
  }
}