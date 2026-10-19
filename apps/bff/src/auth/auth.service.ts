import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../db/prisma.service';
import { signToken } from './jwt';
import type { AuthResponse, LoginRequest, RegisterRequest } from '@ai-office/shared';

/** 邮箱统一小写，避免大小写变体绕过唯一约束或注册出重复账号。 */
function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('invalid_email');
  const email = value.trim().toLowerCase();
  if (!email) throw new BadRequestException('invalid_email');
  return email;
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async register(req: RegisterRequest): Promise<AuthResponse> {
    const email = normalizeEmail(req.email);
    // 大小写不敏感查询：兼容历史库中混合大小写的存量邮箱。
    const existing = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    if (existing) throw new ConflictException('email_taken');

    const passwordHash = await argon2.hash(req.password);
    // 注册路径不授予 admin：管理员须由运维用 admin:promote 脚本预置，
    // 否则任何人抢注白名单邮箱即可提权。
    // 个人用户 = 一个 personal 租户；注册时自动创建（为多租户预留）。
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        role: 'member',
        tenant: { create: { type: 'personal', name: email } },
      },
    });
    return this.issue(user.id, user.tenantId, user.email, user.role);
  }

  async login(req: LoginRequest): Promise<AuthResponse> {
    const email = normalizeEmail(req.email);
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
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
