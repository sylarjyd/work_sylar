import 'reflect-metadata';
import { loadRootEnv } from './load-env';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
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
  // @fastify/multipart 的类型声明基于 fastify 4.29，与本仓 fastify 4.28 的
  // FastifyInstance 存在类型漂移（缺少 multipartErrors）；仅类型层面窄化，运行时行为不变。
  await app.register(multipart as unknown as Parameters<typeof app.register>[0], {
    limits: { fileSize: Number(process.env.KB_MAX_FILE_BYTES ?? 10485760) },
  });
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  console.log(`bff listening on http://localhost:${port}`);
}

void bootstrap();
