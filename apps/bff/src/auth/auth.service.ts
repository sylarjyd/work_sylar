import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../db/prisma.service';
import { signToken } from './jwt';
import type { AuthResponse, LoginRequest, RegisterRequest } from '@ai-office/shared';

/** 平台管理员白名单（逗号分隔邮箱，大小写不敏感）；命中者注册即 admin，其余为 member。 */
function isAdminEmail(email: string): boolean {
  const allow = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(email.trim().toLowerCase());
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async register(req: RegisterRequest): Promise<AuthResponse> {
    const existing = await this.prisma.user.findUnique({ where: { email: req.email } });
    if (existing) throw new ConflictException('email_taken');

    const passwordHash = await argon2.hash(req.password);
    const role = isAdminEmail(req.email) ? 'admin' : 'member';
    // 个人用户 = 一个 personal 租户；注册时自动创建（为多租户预留）。
    const user = await this.prisma.user.create({
      data: {
        email: req.email,
        passwordHash,
        role,
        tenant: { create: { type: 'personal', name: req.email } },
      },
    });
    return this.issue(user.id, user.tenantId, user.email, user.role);
  }

  async login(req: LoginRequest): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({ where: { email: req.email } });
    // 邮箱不存在与密码错误返回同一个错误，避免账号枚举。
    if (!user || !(await argon2.verify(user.passwordHash, req.password))) {
      throw new UnauthorizedException('invalid_credentials');
    }
    return this.issue(user.id, user.tenantId, user.email, user.role);
  }

  private issue(userId: string, tenantId: string, email: string, role: string): AuthResponse {
    return {
      token: signToken({ sub: userId, tenantId }),
      user: { id: userId, email, role },
    };
  }
}
