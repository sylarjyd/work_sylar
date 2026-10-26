import { Module } from '@nestjs/common';
import { PrismaModule } from '../db/prisma.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ArtifactService } from './artifacts.service';
import { ARTIFACT_STORAGE, createArtifactStorage } from './storage';

/** 产物领域模块：服务依赖会话归属校验；存储工厂原样自装配根迁入。 */
@Module({
  imports: [PrismaModule, SessionsModule],
  providers: [
    ArtifactService,
    { provide: ARTIFACT_STORAGE, useFactory: () => createArtifactStorage() },
  ],
  exports: [ArtifactService],
})
export class ArtifactsModule {}
