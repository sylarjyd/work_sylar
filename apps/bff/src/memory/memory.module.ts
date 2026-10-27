import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { EmbeddingClient } from './embedding.client';
import { LongTermMemoryService } from './long-term-memory.service';
import { MemoryLlmClient } from './memory-llm.client';
import { MemoryService } from './memory.service';
import { ShortTermMemoryService } from './short-term-memory.service';

/**
 * 记忆域：短期状态复用 QueueModule 全局导出的 RUN_REDIS，长期记忆走全局 PrismaService。
 * 只导出 MemoryService，执行器不需要感知内部拆分。
 */
@Module({
  imports: [SettingsModule],
  providers: [
    ShortTermMemoryService,
    LongTermMemoryService,
    MemoryLlmClient,
    // 构造函数参数是配置对象而非可注入 token，必须用工厂装配。
    { provide: EmbeddingClient, useFactory: () => new EmbeddingClient() },
    MemoryService,
  ],
  exports: [MemoryService],
})
export class MemoryModule {}
