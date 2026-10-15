import { Body, Controller, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { PromptRequest } from '@ai-office/shared';

@Controller('api/stream')
export class StreamController {
  @Post()
  async stream(@Body() body: PromptRequest, @Res() reply: FastifyReply): Promise<void> {
    // 接管回复：本方法直接写 reply.raw，必须 hijack，否则 Nest/Fastify 会再自动发一次响应。
    reply.hijack();

    // 在请求时读取 env（而非模块加载时）：测试会在 beforeAll 里设置
    // AGENT_RUNTIME_URL，而 ESM 静态 import 早于 beforeAll 执行，模块级读取会拿到旧值。
    const runtimeUrl = process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';

    let upstream: Response;
    try {
      upstream = await fetch(`${runtimeUrl}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: body.goal }),
      });
    } catch {
      // 传输层失败（连接被拒、DNS 失败等）：向上游不可达，回 502 而不是未捕获的 500。
      reply.raw.writeHead(502, { 'content-type': 'application/json' });
      reply.raw.end(JSON.stringify({ error: 'upstream_unreachable' }));
      return;
    }

    if (!upstream.ok) {
      // 上游非 2xx：原样转发真实状态码与响应体，不能伪装成 200 text/event-stream。
      const contentType = upstream.headers.get('content-type') ?? 'application/json';
      reply.raw.writeHead(upstream.status, { 'content-type': contentType });
      const body = await upstream.text();
      reply.raw.end(body);
      return;
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    if (!upstream.body) {
      reply.raw.end();
      return;
    }

    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        reply.raw.write(Buffer.from(value));
      }
    } finally {
      reply.raw.end();
    }
  }
}
