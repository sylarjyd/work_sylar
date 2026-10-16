import type { Tool } from './types';
import { createWebSearchTool, createSearchProvider } from './web-search';
import { createWebFetchTool } from './web-fetch';
import { createDocTools } from './doc';
import { createStorage, type Storage } from '../storage/s3';

/** 内置工具集：web.search / web.fetch + doc.docx / doc.xlsx / doc.pptx。 */
export function createTools(
  env: NodeJS.ProcessEnv = process.env,
  storage: Storage = createStorage(env),
): Tool[] {
  return [
    createWebSearchTool(createSearchProvider(env)),
    createWebFetchTool(),
    ...createDocTools(storage),
  ];
}
