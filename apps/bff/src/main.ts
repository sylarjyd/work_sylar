import 'reflect-metadata';
import { loadRootEnv } from './load-env';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { initTelemetry, shutdownTelemetry } from '@ai-office/telemetry';
import { AppModule } from './app.module';
import { CORS_OPTIONS } from './cors';
import { assertConnectorKey } from './connector/crypto';
import { assertSecretKey } from './secrets/secret-box';
import { AppLogger } from './observability/app-logger';
import { BFF_METRICS, type BffMetrics } from './observability/observability.metrics';
import { registerRequestTelemetry } from './observability/request-telemetry';

loadRootEnv();
initTelemetry({
  serviceName: 'bff',
  serviceVersion: process.env.APP_VERSION ?? '0.0.0',
});

async function bootstrap(): Promise<void> {
  assertConnectorKey();
  // 模型厂商 Key 与连接器密钥互不复用：轮换其中一把不会影响另一类密文。
  assertSecretKey('MODEL_ENC_KEY');
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: true },
  );
  const logger = app.get(AppLogger);
  app.useLogger(logger);
  app.enableCors(CORS_OPTIONS);

  // 钩子必须在 listen 前注册，确保启动后的每个请求都有 trace/日志/指标。
  // getInstance() 的类型来自 @nestjs/platform-fastify 内嵌的 fastify 4.28，与本仓
  // 直接依赖的 fastify 4.29（被 @fastify/multipart 扩展）存在类型漂移；仅类型层面窄化。
  registerRequestTelemetry(
    app.getHttpAdapter().getInstance() as unknown as Parameters<
      typeof registerRequestTelemetry
    >[0],
    app.get<BffMetrics>(BFF_METRICS),
    logger.raw,
  );

  // @fastify/multipart 的类型声明基于 fastify 4.29，与本仓 fastify 4.28 的
  // FastifyInstance 存在类型漂移（缺少 multipartErrors）；仅类型层面窄化，运行时行为不变。
  const maxBytes = Number(process.env.KB_MAX_FILE_BYTES);
  await app.register(multipart as unknown as Parameters<typeof app.register>[0], {
    limits: { fileSize: Number.isFinite(maxBytes) ? maxBytes : 10485760 },
  });
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');

  const close = async (): Promise<void> => {
    await app.close().catch(() => undefined);
    await shutdownTelemetry();
  };
  process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
  process.once('SIGINT', () => void close().finally(() => process.exit(0)));

  logger.log(`bff listening on http://localhost:${port}`);
}

bootstrap().catch(async (err: unknown) => {
  console.error('bff 启动失败', err);
  await shutdownTelemetry();
  process.exit(1);
});
