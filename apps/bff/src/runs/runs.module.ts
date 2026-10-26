import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { RunsService } from './runs.service';

/**
 * 运行领域模块：只装配 RunsService。
 * 队列与控制/事件总线由 AppModule 里的 QueueModule.forRoot() 全局提供，这里不重复导入，
 * 避免出现第二个动态模块实例与重复的 Redis 连接。
 */
@Module({
  imports: [TasksModule],
  providers: [RunsService],
  exports: [RunsService],
})
export class RunsModule {}
