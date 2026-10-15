import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { encodeSse } from '@ai-office/shared';
import { runFakeAgent } from './fake-agent';

export function createRuntimeServer(): Server {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/prompt') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let goal = '';
        try {
          goal = (JSON.parse(body || '{}') as { goal?: string }).goal ?? '';
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json' }));
          return;
        }

        const runId = randomUUID();
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });

        void (async () => {
          try {
            for await (const ev of runFakeAgent(goal, runId)) {
              res.write(encodeSse({ event: 'step', data: ev }));
            }
            res.write(encodeSse({ event: 'done', data: { runId } }));
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

const isEntry = process.argv[1]?.endsWith('server.ts') ||
  process.argv[1]?.endsWith('server.js');

if (isEntry) {
  const port = Number(process.env.PORT ?? 4001);
  createRuntimeServer().listen(port, () => {
    console.log(`agent-runtime listening on http://localhost:${port}`);
  });
}
