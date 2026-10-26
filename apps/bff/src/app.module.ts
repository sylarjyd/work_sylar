import { Module } from '@nestjs/common';
import { PrismaModule } from './db/prisma.module';
import { ObservabilityModule } from './observability/observability.module';
import { MetricsModule } from './metrics/metrics.module';
import { AlertsModule } from './alerts/alerts.module';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { SessionsController } from './sessions/sessions.controller';
import { SessionsModule } from './sessions/sessions.module';
import { TasksController } from './tasks/tasks.controller';
import { TasksModule } from './tasks/tasks.module';
import { RunsController } from './runs/runs.controller';
import { RunsModule } from './runs/runs.module';
import { ArtifactController } from './artifacts/artifacts.controller';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { KbModule } from './kb/kb.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { AssistantsModule } from './assistants/assistants.module';
import { ConnectorModule } from './connector/connector.module';
import { BillingModule } from './billing/billing.module';
import { ModelsModule } from './models/models.module';
import { AdminModule } from './admin/admin.module';
import { SettingsModule } from './settings/settings.module';
import { QueueModule } from './queue/queue.module';

/**
 * 应用装配根：数据库、知识库、连接器、计费、管理端模块在此汇合；
 * 会话、任务、产物、运行按领域各自成模块，控制器仍在此集中挂载。
 */
@Module({
  imports: [
    ObservabilityModule,
    PrismaModule,
    MetricsModule,
    BillingModule,
    ModelsModule,
    SessionsModule,
    TasksModule,
    ArtifactsModule,
    QueueModule.forRoot(),
    RunsModule,
    KbModule,
    AttachmentsModule,
    AssistantsModule,
    ConnectorModule,
    SettingsModule,
    AlertsModule,
    AdminModule,
  ],
  controllers: [AuthController, SessionsController, TasksController, RunsController, ArtifactController],
  providers: [AuthService],
})
export class AppModule {}
