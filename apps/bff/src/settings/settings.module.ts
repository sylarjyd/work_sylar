import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsService } from './settings.service';

@Module({
  imports: [AuditModule],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
