import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AdminAssistantDto, PageDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { AdminAssistantsService } from './admin-assistants.service';

/** 运营端助手列表（只读）：区分公共内置助手与用户个人助手。 */
@Controller('api/admin/assistants')
@UseGuards(JwtGuard, AdminGuard)
export class AdminAssistantsController {
  constructor(private readonly assistants: AdminAssistantsService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<PageDto<AdminAssistantDto>> {
    return this.assistants.list(query ?? {});
  }
}
