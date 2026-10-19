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
})
export class KbModule {}
