import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingAdminController } from './billing-admin.controller';
import { BillingService } from './billing.service';
import { RATE_LIMITER, createRateLimiter } from './billing.rate-limit';

@Module({
  controllers: [BillingController, BillingAdminController],
  providers: [
    BillingService,
    { provide: RATE_LIMITER, useFactory: () => createRateLimiter() },
  ],
  exports: [BillingService],
})
export class BillingModule {}
