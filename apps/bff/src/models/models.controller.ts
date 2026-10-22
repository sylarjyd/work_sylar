import { Controller, Get, UseGuards } from '@nestjs/common';
import type { ClientModelsDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { ModelCatalogService } from './model-catalog.service';

/** 当前登录用户可选的模型：只返回已启用且在本套餐内的项。 */
@Controller('api')
@UseGuards(JwtGuard)
export class ModelsController {
  constructor(private readonly catalog: ModelCatalogService) {}

  @Get('models')
  list(@CurrentUser() user: JwtPayload): Promise<ClientModelsDto> {
    return this.catalog.listForClient(user.tenantId);
  }
}
