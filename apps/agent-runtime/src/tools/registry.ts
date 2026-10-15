import type { Tool } from './types';
import { createWebSearchTool, createSearchProvider } from './web-search';
import { createWebFetchTool } from './web-fetch';

/** M1 内置工具集：web.search + web.fetch（其余留 M2/M4）。 */
export function createTools(env: NodeJS.ProcessEnv = process.env): Tool[] {
  return [createWebSearchTool(createSearchProvider(env)), createWebFetchTool()];
}
