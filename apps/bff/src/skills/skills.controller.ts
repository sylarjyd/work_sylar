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
import type { SkillDto, SkillListDto } from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { SkillsService } from './skills.service';

/** 技能市场（用户侧）：公共技能 + 自己的个人技能；共享后转为公共。 */
@Controller('api/skills')
@UseGuards(JwtGuard)
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload): Promise<SkillListDto> {
    return this.skills.list(user.tenantId, user.sub);
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() body: unknown): Promise<SkillDto> {
    return this.skills.create(user.tenantId, user.sub, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SkillDto> {
    return this.skills.update(id, user.tenantId, user.sub, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<void> {
    await this.skills.remove(id, user.tenantId, user.sub);
  }

  @Post(':id/share')
  share(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<SkillDto> {
    return this.skills.share(id, user.tenantId, user.sub);
  }
}
