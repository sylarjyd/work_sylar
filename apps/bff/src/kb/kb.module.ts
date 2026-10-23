import { Module } from '@nestjs/common';
import { KbController } from './kb.controller';
import { InternalKbController } from './internal-kb.controller';
import { KbService } from './kb.service';
import { KB_STORAGE, createKbStorage } from './storage';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [KbController, InternalKbController],
  providers: [
    KbService,
    { provide: KB_STORAGE, useFactory: () => createKbStorage() },
  ],
  // 运营端知识库管理复用同一服务与存储客户端（删除文档后需清理对象）。
  exports: [KbService, KB_STORAGE],
})
export class KbModule {}
