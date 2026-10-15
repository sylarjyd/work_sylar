import { Body, Controller, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { PromptRequest } from '@ai-office/shared';

@Controller('api/stream')
export class StreamController {
  @Post()
  async stream(@Body() body: PromptRequest, @Res() reply: FastifyReply): Promise<void> {
    // 在请求时读取 env（而非模块加载时）：测试会在 beforeAll 里设置
    // AGENT_RUNTIME_URL，而 ESM 静态 import 早于 beforeAll 执行，模块级读取会拿到旧值。
    const runtimeUrl = process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';
    const upstream = await fetch(`${runtimeUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: body.goal }),
    });

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
