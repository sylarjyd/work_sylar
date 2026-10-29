import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { ModelsModule } from '../models/models.module';
import { InternalSkillsController } from './internal-skills.controller';
import { SkillTestService } from './skill-test.service';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';

@Module({
  imports: [AttachmentsModule, ModelsModule],
  controllers: [SkillsController, InternalSkillsController],
  providers: [SkillsService, SkillTestService],
  exports: [SkillsService, SkillTestService],
})
export class SkillsModule {}
