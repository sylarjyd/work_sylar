import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { ModelCatalogService } from './model-catalog.service';
import { ModelsController } from './models.controller';

@Module({
  imports: [BillingModule],
  controllers: [ModelsController],
  providers: [ModelCatalogService],
  exports: [ModelCatalogService],
})
export class ModelsModule {}
