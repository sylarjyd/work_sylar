import 'reflect-metadata';
import { loadRootEnv } from './load-env';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { CORS_OPTIONS } from './cors';

// 必须在 NestFactory.create 之前：Prisma 连接串、JWT 密钥都在实例化服务时读取。
loadRootEnv();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.enableCors(CORS_OPTIONS);
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  console.log(`bff listening on http://localhost:${port}`);
}

void bootstrap();
