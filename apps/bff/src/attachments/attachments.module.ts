import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { ATTACHMENT_STORAGE, createAttachmentStorage } from './attachments.storage';

@Module({
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    { provide: ATTACHMENT_STORAGE, useFactory: () => createAttachmentStorage() },
  ],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
