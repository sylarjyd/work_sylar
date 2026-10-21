import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { AuthResponse, AuthUser, LoginRequest, RegisterRequest } from '@ai-office/shared';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user';
import { JwtGuard } from './jwt.guard';
import type { JwtPayload } from './jwt';

/** 注册/登录入口：注册默认创建 personal 租户；登录成功返回 7 天有效的 JWT。 */
@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: RegisterRequest): Promise<AuthResponse> {
    return this.auth.register(body);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginRequest): Promise<AuthResponse> {
    return this.auth.login(body);
  }

  /**
   * 当前登录用户身份。JWTGuard 会按 sub 查库回填邮箱与角色，
   * 供签发较早、token 中没有邮箱的客户端补全展示信息。
   */
  @Get('me')
  @UseGuards(JwtGuard)
  me(@CurrentUser() user: JwtPayload): AuthUser {
    return { id: user.sub, email: user.email ?? '', role: user.role ?? 'member' };
  }
}
