import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AssistantDto, AssistantInput, AssistantPatch } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { AssistantsService } from './assistants.service';

/** 自定义助手：客户端按当前登录用户隔离，跨用户访问一律 404。 */
@Controller('api/assistants')
@UseGuards(JwtGuard)
export class AssistantsController {
  constructor(private readonly assistants: AssistantsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload): Promise<AssistantDto[]> {
    return this.assistants.list(user.tenantId, user.sub);
  }

  @Post()
  create(
    @CurrentUser() user: JwtPayload,
    @Body() body: AssistantInput,
  ): Promise<AssistantDto> {
    return this.assistants.create(user.tenantId, user.sub, body ?? ({} as AssistantInput));
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: AssistantPatch,
  ): Promise<AssistantDto> {
    return this.assistants.update(id, user.tenantId, user.sub, body ?? {});
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<void> {
    return this.assistants.remove(id, user.tenantId, user.sub);
  }
}
