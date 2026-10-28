import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { SkillsController } from './skills.controller';
import { InternalSkillsController } from './internal-skills.controller';
import { SkillsService } from './skills.service';

@Module({
  imports: [AttachmentsModule],
  controllers: [SkillsController, InternalSkillsController],
  providers: [SkillsService],
  exports: [SkillsService],
})
export class SkillsModule {}
