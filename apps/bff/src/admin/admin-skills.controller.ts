import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  SKILL_LIMITS,
  type PageDto,
  type SkillDto,
  type SkillPackageContentsDto,
  type SkillTestResultDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { actorOf } from '../audit/audit.types';
import { AdminSkillsService } from './admin-skills.service';

/** 运营端技能管理：列表区分公共/个人，公共技能可增删改与启停，个人技能只读。 */
@Controller('api/admin/skills')
@UseGuards(JwtGuard, AdminGuard)
export class AdminSkillsController {
  private readonly logger = new Logger(AdminSkillsController.name);

  constructor(private readonly skills: AdminSkillsService) {}

  @Get()
  list(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<PageDto<SkillDto>> {
    return this.skills.list(query ?? {}, actorOf(user, req));
  }

  @Post()
  create(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ): Promise<SkillDto> {
    return this.skills.create(body, actorOf(user, req));
  }

  /** 编辑器新建公共技能：一次性提交 frontmatter 字段与包内文本文件。 */
  @Post('package')
  createPackage(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Body() body: unknown,
  ): Promise<SkillDto> {
    return this.skills.savePackage(body, actorOf(user, req));
  }

  @Get(':id/package')
  packageContents(@Param('id') id: string): Promise<SkillPackageContentsDto> {
    return this.skills.packageContents(id);
  }

  /** 技能测试：选模型跑一次只注入该技能的对话。 */
  @Post(':id/test')
  testSkill(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SkillTestResultDto> {
    return this.skills.testSkill(id, user.tenantId, user.sub, body);
  }

  @Put(':id/package')
  savePackage(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SkillDto> {
    return this.skills.savePackage(body, actorOf(user, req), id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SkillDto> {
    return this.skills.update(id, body, actorOf(user, req));
  }

  @Post(':id/enabled')
  setEnabled(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: { enabled?: unknown },
  ): Promise<SkillDto> {
    return this.skills.setEnabled(id, body?.enabled === true, actorOf(user, req));
  }

  /** 上传公共技能包：zip 根目录（或单层目录）下含 SKILL.md。 */
  @Post('upload')
  async upload(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    let file: Awaited<ReturnType<FastifyRequest['file']>>;
    try {
      file = await req.file({ limits: { fileSize: SKILL_LIMITS.packageBytes } });
    } catch (err) {
      const code = (err as { code?: string }).code;
      reply
        .status(code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 400)
        .send({ error: code === 'FST_REQ_FILE_TOO_LARGE' ? 'package_too_large' : 'invalid_upload' });
      return;
    }
    if (!file) {
      reply.status(400).send({ error: 'missing_file' });
      return;
    }
    if (!/\.zip$/i.test(file.filename)) {
      await file.toBuffer().catch(() => undefined);
      reply.status(400).send({ error: 'invalid_zip' });
      return;
    }
    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      reply.status(413).send({ error: 'package_too_large' });
      return;
    }
    try {
      reply.status(201).send(await this.skills.createFromPackage(buffer, actorOf(user, req)));
    } catch (err) {
      this.logger.warn(`运营端技能包上传失败: ${(err as Error).message}`);
      const message = (err as { response?: { message?: unknown } }).response?.message;
      reply
        .status(400)
        .send({ error: typeof message === 'string' ? message : 'invalid_skill_package' });
    }
  }

  /** 预览公共技能包内文件。 */
  @Get(':id/file')
  async file(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Query('path') path: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!path) {
      reply.status(400).send({ error: 'missing_path' });
      return;
    }
    try {
      const result = await this.skills.readPackageFile(id, path, actorOf(user, req));
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', String(result.buffer.length));
      reply.header('x-content-type-options', 'nosniff');
      await reply.send(result.buffer);
    } catch (err) {
      reply
        .status(err instanceof NotFoundException ? 404 : 502)
        .send({ error: 'skill_file_unavailable' });
    }
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<void> {
    await this.skills.remove(id, actorOf(user, req));
  }
}
