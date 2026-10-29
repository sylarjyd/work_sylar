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
  type SkillDto,
  type SkillListDto,
  type SkillPackageContentsDto,
  type SkillTestResultDto,
} from '@ai-office/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../auth/current-user';
import type { JwtPayload } from '../auth/jwt';
import { SkillsService } from './skills.service';
import { SkillTestService } from './skill-test.service';

/** 技能市场（用户侧）：公共技能 + 自己的个人技能；支持技能包上传与包内文件读取。 */
@Controller('api/skills')
@UseGuards(JwtGuard)
export class SkillsController {
  private readonly logger = new Logger(SkillsController.name);

  constructor(
    private readonly skills: SkillsService,
    private readonly skillTest: SkillTestService,
  ) {}

  @Get()
  list(@CurrentUser() user: JwtPayload): Promise<SkillListDto> {
    return this.skills.list(user.tenantId, user.sub);
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() body: unknown): Promise<SkillDto> {
    return this.skills.create(user.tenantId, user.sub, body);
  }

  /** 编辑器新建：一次性提交 frontmatter 字段与包内文本文件。 */
  @Post('package')
  createPackage(@CurrentUser() user: JwtPayload, @Body() body: unknown): Promise<SkillDto> {
    return this.skills.savePackage({ tenantId: user.tenantId, userId: user.sub }, body);
  }

  /** 技能测试：选模型跑一次只注入该技能的对话。 */
  @Post(':id/test')
  testSkill(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SkillTestResultDto> {
    return this.skillTest.run({ tenantId: user.tenantId, userId: user.sub }, id, body);
  }

  /** 编辑器读取包内文本文件（二进制只在清单里出现）。 */
  @Get(':id/package')
  packageContents(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<SkillPackageContentsDto> {
    return this.skills.packageContents(id, user.tenantId, user.sub);
  }

  /** 编辑器保存：未提交的旧文件保留，必要时删掉旧包。 */
  @Put(':id/package')
  savePackage(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SkillDto> {
    return this.skills.savePackage({ tenantId: user.tenantId, userId: user.sub, id }, body);
  }

  /** 上传 Agent Skills 技能包（zip，根目录或单层目录下含 SKILL.md）。 */
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
      const dto = await this.skills.createFromPackage(user.tenantId, user.sub, buffer);
      reply.status(201).send(dto);
    } catch (err) {
      if (err instanceof NotFoundException) {
        reply.status(404).send({ error: err.message });
        return;
      }
      this.logger.warn(`技能包上传失败: ${(err as Error).message}`);
      const message = (err as { response?: { message?: unknown } }).response?.message;
      reply.status(400).send({ error: typeof message === 'string' ? message : 'invalid_skill_package' });
    }
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

  /** 读取技能包内文件（预览/下载）；不在清单里的路径按 404 处理。 */
  @Get(':id/file')
  async file(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('path') path: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!path) {
      reply.status(400).send({ error: 'missing_path' });
      return;
    }
    try {
      const result = await this.skills.readPackageFile(id, {
        tenantId: user.tenantId,
        userId: user.sub,
      }, path);
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', String(result.buffer.length));
      reply.header('x-content-type-options', 'nosniff');
      reply.header(
        'content-disposition',
        `attachment; filename="${(result.filename ?? 'file').replace(/["\\]/g, '')}"`,
      );
      await reply.send(result.buffer);
    } catch (err) {
      reply.status(err instanceof NotFoundException ? 404 : 502).send({ error: 'skill_file_unavailable' });
    }
  }
}
