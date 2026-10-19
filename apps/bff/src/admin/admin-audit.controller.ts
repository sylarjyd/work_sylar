import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AdminAuditItemDto, PageDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { AuditService } from '../audit/audit.service';

/** 管理端审计接口：按条件分页查询管理操作记录，统一要求管理员角色。 */
@Controller('api/admin/audit')
@UseGuards(JwtGuard, AdminGuard)
export class AdminAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<PageDto<AdminAuditItemDto>> {
    return this.audit.list(query ?? {});
  }
}
