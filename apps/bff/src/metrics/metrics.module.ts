import { Global, Module } from '@nestjs/common';
import { LEADER_LOCK, createLeaderLock } from './leader-lock';
import { MetricsSweeper } from './metrics.sweeper';

/** 全局导出选主器，告警模块复用同一条 Redis 连接。 */
@Global()
@Module({
  providers: [
    { provide: LEADER_LOCK, useFactory: () => createLeaderLock() },
    MetricsSweeper,
  ],
  exports: [LEADER_LOCK],
})
export class MetricsModule {}
