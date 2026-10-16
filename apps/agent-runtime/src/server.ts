import { createServer, type IncomingMessage, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { encodeSse } from '@ai-office/shared';
import type { RunRequest } from '@ai-office/shared';
import { runAgent } from './agent-loop';
import { createGateway } from './model/create-gateway';
import type { ModelGateway } from './model/types';
import { createTools } from './tools/registry';
import type { Tool } from './tools/types';
import { ConfirmBroker } from './confirm/broker';
import { loadRootEnv } from './load-env';
import { createStorage, type Storage } from './storage/s3';
import { createEmbeddingGateway } from './embedding/create-embedding-gateway';
import type { EmbeddingGateway } from './embedding/types';
import { ingest } from './kb/ingest';

export interface RuntimeDeps {
  gateway?: ModelGateway;
  tools?: Tool[];
  storage?: Storage;
  embedding?: EmbeddingGateway;
}

export function createRuntimeServer(deps: RuntimeDeps = {}): Server {
  const gateway = deps.gateway ?? createGateway();
  const storage = deps.storage ?? createStorage();
  const tools = deps.tools ?? createTools(process.env, storage);
  const embedding = deps.embedding ?? createEmbeddingGateway();
  // runtime 单实例持有一份确认闸门；连接 close 时按 runId 取消挂起。
  const confirm = new ConfirmBroker();
  const confirmTimeoutMs = Number(process.env.CONFIRM_TIMEOUT_MS ?? 120000);

  // BFF→runtime 共享密钥：设置 AGENT_RUNTIME_TOKEN 后强制校验，供网络化部署用；
  // 未设置时仅靠入口默认绑本机（见 isEntry）限制可达面。
  const authorized = (req: IncomingMessage): boolean => {
    const token = process.env.AGENT_RUNTIME_TOKEN;
    return !token || req.headers['x-agent-runtime-token'] === token;
  };

  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/runs') {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
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
        // 客户端断开：把该 run 的挂起闸门按拒绝兑现，避免悬停到超时。
        res.on('close', () => confirm.cancel(runReq.runId));

        void (async () => {
          try {
            for await (const ev of runAgent(runReq, {
              gateway,
              tools,
              confirm,
              confirmTimeoutMs,
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

    const confirmMatch = req.method === 'POST' && /^\/runs\/([^/]+)\/confirm$/.exec(req.url ?? '');
    if (confirmMatch) {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const runId = decodeURIComponent(confirmMatch[1]);
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let decision: { confirmId?: unknown; approved?: unknown };
        try {
          decision = JSON.parse(body || '{}') as typeof decision;
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json' }));
          return;
        }
        if (
          typeof decision.confirmId !== 'string' ||
          decision.confirmId === '' ||
          typeof decision.approved !== 'boolean'
        ) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_decision' }));
          return;
        }
        // runtime 无 run 注册表，区分不了「未知 run」与「已决」；二者统一 matched:false（幂等安全）。
        const matched = confirm.resolve(runId, decision.confirmId, decision.approved);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, matched }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/kb/ingest') {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        void (async () => {
          let payload: { storageKey?: unknown; filename?: unknown; mime?: unknown };
          try {
            const parsed: unknown = JSON.parse(body || '{}');
            // 非对象（含字面量 null / 数组 / 标量）一律视为非法体，避免后续取属性抛错逃出保护块。
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('not_object');
            }
            payload = parsed as { storageKey?: unknown; filename?: unknown; mime?: unknown };
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
            return;
          }
          const storageKey = String(payload.storageKey ?? '');
          const filename = String(payload.filename ?? '');
          const mime = typeof payload.mime === 'string' ? payload.mime : undefined;
          if (!storageKey || !filename) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'missing_params' }));
            return;
          }
          try {
            const stream = await storage.getObjectStream(storageKey);
            const chunks: Buffer[] = [];
            for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
            const data = Buffer.concat(chunks);
            const out = await ingest(
              { data, filename, mime },
              { embed: embedding },
              {
                chunkSize: Number(process.env.KB_CHUNK_SIZE ?? 800),
                chunkOverlap: Number(process.env.KB_CHUNK_OVERLAP ?? 150),
              },
            );
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, chunks: out }));
          } catch (err) {
            // 摄取失败是预期内业务结果（异步、前端轮询可见），回 200 + ok:false，不当作传输错误。
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
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
  const storage = createStorage();
  try {
    await storage.ensureBucket();
  } catch (err) {
    console.warn(`ensureBucket 失败（文档工具将在运行期报错）: ${(err as Error).message}`);
  }
  // 独立端口变量：与 bff 的 PORT 分开，避免根 .env 里 PORT=4000 把 runtime 也顶到 4000。
  const port = Number(process.env.AGENT_RUNTIME_PORT ?? 4001);
  // 默认只绑本机：该端点无内置鉴权（仅有可选 token），暴露到网络等于开放一个无鉴权的模型入口。
  // 部署到网络时须显式设 AGENT_RUNTIME_HOST=0.0.0.0 并同时配置 AGENT_RUNTIME_TOKEN。
  const host = process.env.AGENT_RUNTIME_HOST ?? '127.0.0.1';
  createRuntimeServer({ storage }).listen(port, host, () => {
    console.log(`agent-runtime listening on http://${host}:${port}`);
  });
}
