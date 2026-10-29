import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { BillingModule } from '../billing/billing.module';
import { AlertsModule } from '../alerts/alerts.module';
import { KbModule } from '../kb/kb.module';
import { RunsModule } from '../runs/runs.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminPlansController } from './admin-plans.controller';
import { AdminPlansService } from './admin-plans.service';
import { AdminSessionsController } from './admin-sessions.controller';
import { AdminSessionsService } from './admin-sessions.service';
import { AdminTasksController } from './admin-tasks.controller';
import { AdminTasksService } from './admin-tasks.service';
import { AdminModelsController } from './admin-models.controller';
import { AdminModelsService } from './admin-models.service';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminAuditController } from './admin-audit.controller';
import { AdminObservabilityController } from './admin-observability.controller';
import { AdminObservabilityService } from './admin-observability.service';
import { AdminAlertsController } from './admin-alerts.controller';
import { AdminAlertsService } from './admin-alerts.service';
import { AdminKbController } from './admin-kb.controller';
import { AdminKbService } from './admin-kb.service';
import { AdminQaCacheController } from './admin-qa-cache.controller';
import { AdminQaCacheService } from './admin-qa-cache.service';
import { AdminAttachmentsController } from './admin-attachments.controller';
import { AttachmentsModule } from '../attachments/attachments.module';
import { SkillsModule } from '../skills/skills.module';
import { AdminSkillsController } from './admin-skills.controller';
import { AdminSkillsService } from './admin-skills.service';

/** 管理端模块：用户/租户/套餐/会话/任务/模型/参数/审计/概览/告警/知识库/问答缓存/附件预览统一装配。 */
@Module({
  imports: [
    AuditModule,
    SettingsModule,
    BillingModule,
    AlertsModule,
    KbModule,
    RunsModule,
    AttachmentsModule,
    SkillsModule,
  ],
  controllers: [
    AdminUsersController,
    AdminTenantsController,
    AdminPlansController,
    AdminSessionsController,
    AdminTasksController,
    AdminModelsController,
    AdminSettingsController,
    AdminAuditController,
    AdminObservabilityController,
    AdminAlertsController,
    AdminKbController,
    AdminQaCacheController,
    AdminAttachmentsController,
    AdminSkillsController,
  ],
  providers: [
    AdminUsersService,
    AdminTenantsService,
    AdminPlansService,
    AdminSessionsService,
    AdminTasksService,
    AdminModelsService,
    AdminObservabilityService,
    AdminAlertsService,
    AdminKbService,
    AdminQaCacheService,
    AdminSkillsService,
  ],
})
export class AdminModule {}
