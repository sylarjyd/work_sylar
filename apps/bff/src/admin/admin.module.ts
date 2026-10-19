import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { BillingModule } from '../billing/billing.module';
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

/** 管理端模块：用户/租户/套餐/会话/任务/模型/参数/审计八组路由统一装配。 */
@Module({
  imports: [AuditModule, SettingsModule, BillingModule],
  controllers: [
    AdminUsersController,
    AdminTenantsController,
    AdminPlansController,
    AdminSessionsController,
    AdminTasksController,
    AdminModelsController,
    AdminSettingsController,
    AdminAuditController,
  ],
  providers: [
    AdminUsersService,
    AdminTenantsService,
    AdminPlansService,
    AdminSessionsService,
    AdminTasksService,
    AdminModelsService,
  ],
})
export class AdminModule {}
