import { Module } from '@nestjs/common';
import { PrismaModule } from '../db/prisma.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TasksService } from './tasks.service';

/** 任务领域模块：任务依赖会话归属校验，导出服务供运行与控制器使用。 */
@Module({
  imports: [PrismaModule, SessionsModule],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
