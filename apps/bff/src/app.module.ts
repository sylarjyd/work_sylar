import { Module } from '@nestjs/common';
import { PrismaModule } from './db/prisma.module';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { SessionsController } from './sessions/sessions.controller';
import { SessionsService } from './sessions/sessions.service';
import { TasksController } from './tasks/tasks.controller';
import { TasksService } from './tasks/tasks.service';
import { RunsController } from './runs/runs.controller';
import { ArtifactController } from './artifacts/artifacts.controller';
import { ArtifactService } from './artifacts/artifacts.service';
import { ARTIFACT_STORAGE, createArtifactStorage } from './artifacts/storage';
import { KbModule } from './kb/kb.module';
import { ConnectorModule } from './connector/connector.module';

@Module({
  imports: [PrismaModule, KbModule, ConnectorModule],
  controllers: [AuthController, SessionsController, TasksController, RunsController, ArtifactController],
  providers: [
    AuthService,
    SessionsService,
    TasksService,
    ArtifactService,
    { provide: ARTIFACT_STORAGE, useFactory: () => createArtifactStorage() },
  ],
})
export class AppModule {}
