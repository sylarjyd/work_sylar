import { Module } from '@nestjs/common';
import { PrismaModule } from './db/prisma.module';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { SessionsController } from './sessions/sessions.controller';
import { SessionsService } from './sessions/sessions.service';
import { TasksController } from './tasks/tasks.controller';
import { TasksService } from './tasks/tasks.service';

@Module({
  imports: [PrismaModule],
  controllers: [AuthController, SessionsController, TasksController],
  providers: [AuthService, SessionsService, TasksService],
})
export class AppModule {}
