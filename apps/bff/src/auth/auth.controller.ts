import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { AuthResponse, LoginRequest, RegisterRequest } from '@ai-office/shared';

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
}
