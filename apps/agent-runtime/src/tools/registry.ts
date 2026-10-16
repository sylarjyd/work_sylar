import type { Tool } from './types';
import { createWebSearchTool, createSearchProvider } from './web-search';
import { createWebFetchTool } from './web-fetch';
import { createDocTools } from './doc';
import { createCodeExecTool } from './code-exec';
import { createKbRetrieveTool } from './kb-retrieve';
import { createEmbeddingGateway } from '../embedding/create-embedding-gateway';
import { createStorage, type Storage } from '../storage/s3';

/** 内置工具集：web.search / web.fetch + doc.docx / doc.xlsx / doc.pptx + code.exec + kb.retrieve。 */
export function createTools(
  env: NodeJS.ProcessEnv = process.env,
  storage: Storage = createStorage(env),
): Tool[] {
  return [
    createWebSearchTool(createSearchProvider(env)),
    createWebFetchTool(),
    ...createDocTools(storage),
    createCodeExecTool(env),
    createKbRetrieveTool({
      baseUrl: env.BFF_INTERNAL_URL ?? 'http://localhost:4000',
      internalToken: env.INTERNAL_TOKEN,
      embed: createEmbeddingGateway(env),
    }),
  ];
}
