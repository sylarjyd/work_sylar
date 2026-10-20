import { Global, Module } from '@nestjs/common';
import { AppLogger } from './app-logger';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { MetricsController } from './metrics.controller';
import { BFF_METRICS, createBffMetrics } from './observability.metrics';

@Global()
@Module({
  controllers: [MetricsController, HealthController],
  providers: [
    { provide: BFF_METRICS, useFactory: () => createBffMetrics() },
    AppLogger,
    HealthService,
  ],
  exports: [BFF_METRICS, AppLogger, HealthService],
})
export class ObservabilityModule {}
