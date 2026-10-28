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
import { MemoryModule } from '../memory/memory.module';
import { SkillsModule } from '../skills/skills.module';
import { ObservabilityModule } from '../observability/observability.module';
import { SettingsModule } from '../settings/settings.module';
import { QaCacheService } from '../qa-cache/qa-cache.service';
import { QaCacheSweeper } from '../qa-cache/qa-cache.sweeper';
import { TasksModule } from '../tasks/tasks.module';
import { readQueueConfig, type QueueRuntimeConfig } from './queue.config';
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
import { RunRecoveryService } from './run-recovery.service';
import { RunRelayService } from './run-relay.service';
import { RunWorker } from './run-worker';

/**
 * 运行队列模块：按 REDIS_URL 条件装配。
 * - 有 Redis：BullMQ 队列 + worker + 跨进程总线；
 * - 无 Redis：不创建任何连接，总线退化为进程内实现，submit 走内联执行。
 * 条件在 provider 实例化时（env 已加载后）确定，不在 forRoot() 调用时读取，
 * 运行期不支持热切换（避免半连接状态）。
 */
@Module({})
export class QueueModule implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueModule.name);

  constructor(
    @Inject(RUN_EVENT_BUS) private readonly events: RunEventBus,
    @Inject(RUN_CONTROL_BUS) private readonly controls: RunControlBus,
    private readonly worker: RunWorker,
    @Optional() @Inject(RUN_QUEUE) private readonly queue: RunQueue | null,
    @Optional() @Inject(RUN_REDIS) private readonly redis: Redis | null,
  ) {}

  static forRoot(): DynamicModule {
    // forRoot() 在模块导入求值时调用，可能早于 .env 加载；所有依赖环境的 provider
    // 必须用 factory，等 Nest 实例化时再读 process.env，否则 REDIS_URL 恒为未配置。
    const providers: Provider[] = [
      { provide: QUEUE_CONFIG, useFactory: () => readQueueConfig() },
      {
        provide: RUN_REDIS,
        useFactory: (cfg: QueueRuntimeConfig): Redis | null =>
          cfg.enabled && cfg.redisUrl ? createRunRedis(cfg.redisUrl) : null,
        inject: [QUEUE_CONFIG],
      },
      {
        provide: RUN_QUEUE,
        useFactory: (cfg: QueueRuntimeConfig, redis: Redis | null): RunQueue | null => {
          if (!redis) return null;
          const queue = new Queue<RunJob, void, 'run'>(cfg.name, { connection: redis });
          // 未监听 error 时 BullMQ 的 EventEmitter 错误会逃逸成未捕获异常。
          queue.on('error', (err) => {
            new Logger('RunQueue').error(`队列连接错误: ${err.message}`);
          });
          return queue;
        },
        inject: [QUEUE_CONFIG, RUN_REDIS],
      },
      {
        provide: RUN_EVENT_BUS,
        useFactory: (cfg: QueueRuntimeConfig, redis: Redis | null): RunEventBus =>
          redis
            ? new RedisRunEventBus(redis, () => createSubscriber(cfg.redisUrl!))
            : new LocalRunEventBus(),
        inject: [QUEUE_CONFIG, RUN_REDIS],
      },
      {
        provide: RUN_CONTROL_BUS,
        useFactory: (cfg: QueueRuntimeConfig, redis: Redis | null): RunControlBus =>
          redis
            ? new RedisRunControlBus(redis, () => createSubscriber(cfg.redisUrl!))
            : new LocalRunControlBus(),
        inject: [QUEUE_CONFIG, RUN_REDIS],
      },
      RunExecutor,
      RunQueueService,
      RunRelayService,
      // 启动 + 周期恢复：仅队列模式生效，内部按 config/queue 自行短路。
      RunRecoveryService,
      QaCacheService,
      QaCacheSweeper,
      RunWorker,
    ];

    return {
      module: QueueModule,
      // 全局导出：其他领域模块（如 RunsModule）可在不导入本模块的前提下注入
      // RUN_CONTROL_BUS/RUN_EVENT_BUS/RunQueueService，避免二次 forRoot 造成重复连接。
      global: true,
      imports: [
        PrismaModule,
        ObservabilityModule,
        TasksModule,
        ArtifactsModule,
        AttachmentsModule,
        BillingModule,
        SettingsModule,
        MemoryModule,
        SkillsModule,
      ],
      providers,
      exports: [
        RunQueueService,
        RunExecutor,
        RunRelayService,
        RUN_EVENT_BUS,
        RUN_CONTROL_BUS,
        RUN_REDIS,
        QaCacheService,
      ],
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
