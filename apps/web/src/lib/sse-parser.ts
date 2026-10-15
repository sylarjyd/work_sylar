import { parseSseFrame, type SseMessage } from '@ai-office/shared';

/**
 * 有状态的 SSE 解析器：维护缓冲区，跨网络分片逐个产出完整事件。
 * 复用 shared 的 parseSseFrame，避免重复解析逻辑。
 */
export function createSseParser(): (chunk: string) => SseMessage[] {
  let buffer = '';

  return function parse(chunk: string): SseMessage[] {
    buffer += chunk;
    const events: SseMessage[] = [];

    for (;;) {
      const sep = buffer.indexOf('\n\n');
      if (sep === -1) break;
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const msg = parseSseFrame(frame);
      if (msg) events.push(msg);
    }
    return events;
  };
}
