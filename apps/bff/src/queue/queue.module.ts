import {
  Inject,
  Logger,
  Module,
  Optional,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { BillingModule } from '../billing/billing.module';
import { PrismaModule } from '../db/prisma.module';
import { ObservabilityModule } from '../observability/observability.module';
import { SettingsModule } from '../settings/settings.module';
import { TasksModule } from '../tasks/tasks.module';
import { readQueueConfig } from './queue.config';
import {
  QUEUE_CONFIG,
  RUN_CONTROL_BUS,
  RUN_EVENT_BUS,
  RUN_QUEUE,
  type RunQueue,
} from './queue.tokens';
import { createRunRedis, createSubscriber, RUN_REDIS } from './redis.provider';
import { LocalRunControlBus, RedisRunControlBus, type RunControlBus } from './run-control-bus';
import { LocalRunEventBus, RedisRunEventBus, type RunEventBus } from './run-event-bus';
import { RunExecutor } from './run-executor.service';
import type { RunJob } from './run-job';
import { RunQueueService } from './run-queue.service';
import { RunWorker } from './run-worker';

/**
 * 运行队列模块：按 REDIS_URL 条件装配。
 * - 有 Redis：BullMQ 队列 + worker + 跨进程总线；
 * - 无 Redis：不创建任何连接，总线退化为进程内实现，submit 走内联执行。
 * 条件在 forRoot() 调用时确定，运行期不支持热切换（避免半连接状态）。
 */
@Module({})
export class QueueModule implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueModule.name);

  constructor(
    @Inject(RUN_EVENT_BUS) private readonly events: RunEventBus,
    @Inject(RUN_CONTROL_BUS) private readonly controls: RunControlBus,
    private readonly worker: RunWorker,
    @Optional() @Inject(RUN_QUEUE) private readonly queue: RunQueue | null,
    @Optional() @Inject(RUN_REDIS) private readonly redis: Redis | undefined,
  ) {}

  static forRoot(): DynamicModule {
    const config = readQueueConfig();
    const redisUrl = config.redisUrl;

    const providers: Provider[] = [
      { provide: QUEUE_CONFIG, useValue: config },
      RunExecutor,
      RunQueueService,
      RunWorker,
    ];

    if (config.enabled && redisUrl) {
      providers.push(
        { provide: RUN_REDIS, useFactory: () => createRunRedis(redisUrl) },
        {
          provide: RUN_QUEUE,
          useFactory: (redis: Redis): RunQueue => {
            const queue = new Queue<RunJob, void, 'run'>(config.name, { connection: redis });
            // 未监听 error 时 BullMQ 的 EventEmitter 错误会逃逸成未捕获异常。
            queue.on('error', (err) => {
              new Logger('RunQueue').error(`队列连接错误: ${err.message}`);
            });
            return queue;
          },
          inject: [RUN_REDIS],
        },
        {
          provide: RUN_EVENT_BUS,
          useFactory: (redis: Redis) =>
            new RedisRunEventBus(redis, () => createSubscriber(redisUrl)),
          inject: [RUN_REDIS],
        },
        {
          provide: RUN_CONTROL_BUS,
          useFactory: (redis: Redis) =>
            new RedisRunControlBus(redis, () => createSubscriber(redisUrl)),
          inject: [RUN_REDIS],
        },
      );
    } else {
      // 显式提供 null 而不是不提供，装配期即可确定「队列不可用」而非依赖可选注入。
      providers.push(
        { provide: RUN_QUEUE, useValue: null },
        { provide: RUN_EVENT_BUS, useValue: new LocalRunEventBus() },
        { provide: RUN_CONTROL_BUS, useValue: new LocalRunControlBus() },
      );
    }

    return {
      module: QueueModule,
      imports: [
        PrismaModule,
        ObservabilityModule,
        TasksModule,
        ArtifactsModule,
        AttachmentsModule,
        BillingModule,
        SettingsModule,
      ],
      providers,
      exports: [RunQueueService, RunExecutor, RUN_EVENT_BUS, RUN_CONTROL_BUS],
    };
  }

  /**
   * 关闭顺序：worker（停止拉取并等待在途作业）→ queue → 总线订阅连接 → Redis。
   * worker 先停可避免它继续使用随后关闭的连接；总线与 Redis 的关闭互相独立，
   * 单步失败只记日志，不能阻止其余资源释放。
   */
  async onApplicationShutdown(): Promise<void> {
    await this.worker.close();

    if (this.queue) {
      try {
        await this.queue.close();
      } catch (err) {
        this.logger.warn(`关闭运行队列失败: ${(err as Error).message}`);
      }
    }

    await Promise.allSettled([
      this.events.close?.() ?? Promise.resolve(),
      this.controls.close?.() ?? Promise.resolve(),
    ]);

    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        // 断线时 quit 可能失败，直接断开套接字，避免进程退出被连接拖住。
        this.redis.disconnect();
      }
    }
  }
}
