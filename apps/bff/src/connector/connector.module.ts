import { Module } from '@nestjs/common';
import { ConnectorController } from './connector.controller';
import { InternalConnectorController } from './internal-connector.controller';
import { ConnectorService } from './connector.service';
import { AdminGuard } from '../auth/admin.guard';

@Module({
  controllers: [ConnectorController, InternalConnectorController],
  providers: [ConnectorService, AdminGuard],
})
export class ConnectorModule {}
