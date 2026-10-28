import type { Tool } from './types';
import { createWebSearchTool, createSearchProvider } from './web-search';
import { createWebFetchTool } from './web-fetch';
import { createDocTools } from './doc';
import { createFileTools } from './file-write';
import { createCodeExecTool } from './code-exec';
import { createKbRetrieveTool } from './kb-retrieve';
import { createChartTool } from './chart';
import { createSkillTool } from './skill';
import { createEmbeddingGateway } from '../embedding/create-embedding-gateway';
import { createStorage, type Storage } from '../storage/s3';

/** 内置工具集：web.* + doc.* + file.write + code.exec + kb.retrieve + chart.render + skill.save。 */
export function createTools(
  env: NodeJS.ProcessEnv = process.env,
  storage: Storage = createStorage(env),
): Tool[] {
  return [
    createWebSearchTool(createSearchProvider(env)),
    createWebFetchTool(),
    ...createDocTools(storage),
    ...createFileTools(storage),
    createCodeExecTool(env),
    createKbRetrieveTool({
      baseUrl: env.BFF_INTERNAL_URL ?? 'http://localhost:4000',
      internalToken: env.INTERNAL_TOKEN,
      embed: createEmbeddingGateway(env),
    }),
    createChartTool(),
    createSkillTool(),
  ];
}
