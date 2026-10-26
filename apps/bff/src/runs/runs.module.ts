import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';

/** 运行领域模块占位：M5b-3 后续在此挂载 RunsService 与任务队列装配。 */
@Module({
  imports: [TasksModule],
  providers: [],
  exports: [],
})
export class RunsModule {}
