import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { aggregator: true, discoAdmin: true, employee: { include: { role: true } }, systemAdmin: true },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException({ success: false, message: 'Invalid email or password' });
    }

    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException({ success: false, message: 'Invalid email or password' });
    }

    const payload = {
      userId: user.id,
      userType: user.userType,
      email: user.email,
      roleId: user.employee?.roleId,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '24h' });

    return {
      success: true,
      data: {
        token,
        user: { id: user.id, email: user.email, name: user.name, userType: user.userType },
      },
    };
  }
}