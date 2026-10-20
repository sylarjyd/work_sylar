import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { BillingModule } from '../billing/billing.module';
import { AlertsModule } from '../alerts/alerts.module';
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

/** 管理端模块：用户/租户/套餐/会话/任务/模型/参数/审计/概览/告警十组路由统一装配。 */
@Module({
  imports: [AuditModule, SettingsModule, BillingModule, AlertsModule],
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
  ],
})
export class AdminModule {}
