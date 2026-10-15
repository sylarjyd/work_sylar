import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { AuthResponse, LoginRequest, RegisterRequest } from '@ai-office/shared';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: RegisterRequest): Promise<AuthResponse> {
    return this.auth.register(body);
  }

  @Post('login')
  login(@Body() body: LoginRequest): Promise<AuthResponse> {
    return this.auth.login(body);
  }
}
