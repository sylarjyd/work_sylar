import { Module } from '@nestjs/common';
import { PrismaModule } from '../db/prisma.module';
import { ModelsModule } from '../models/models.module';
import { SessionsService } from './sessions.service';

/** 会话领域模块：建会话需要读取可用模型，故导入模型模块。 */
@Module({
  imports: [PrismaModule, ModelsModule],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
