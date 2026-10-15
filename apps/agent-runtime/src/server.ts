import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { encodeSse } from '@ai-office/shared';
import type { RunRequest } from '@ai-office/shared';
import { runAgent } from './agent-loop';
import { createGateway } from './model/create-gateway';
import type { ModelGateway } from './model/types';
import { createTools } from './tools/registry';
import type { Tool } from './tools/types';
import { loadRootEnv } from './load-env';

export interface RuntimeDeps {
  gateway?: ModelGateway;
  tools?: Tool[];
}

export function createRuntimeServer(deps: RuntimeDeps = {}): Server {
  const gateway = deps.gateway ?? createGateway();
  const tools = deps.tools ?? createTools();

  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/runs') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let runReq: RunRequest;
        try {
          runReq = JSON.parse(body || '{}') as RunRequest;
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json' }));
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });

        void (async () => {
          try {
            for await (const ev of runAgent(runReq, {
              gateway,
              tools,
              onUsage: (u) => res.write(encodeSse({ event: 'usage', data: u })),
            })) {
              res.write(encodeSse({ event: 'step', data: ev }));
            }
            res.write(encodeSse({ event: 'done', data: { runId: runReq.runId } }));
          } catch (err) {
            res.write(encodeSse({ event: 'error', data: { message: String(err) } }));
          } finally {
            res.end();
          }
        })();
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

const isEntry = !!process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  loadRootEnv();
  // 独立端口变量：与 bff 的 PORT 分开，避免根 .env 里 PORT=4000 把 runtime 也顶到 4000。
  const port = Number(process.env.AGENT_RUNTIME_PORT ?? 4001);
  createRuntimeServer().listen(port, () => {
    console.log(`agent-runtime listening on http://localhost:${port}`);
  });
}
