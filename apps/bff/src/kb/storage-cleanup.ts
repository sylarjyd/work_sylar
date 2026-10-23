import type { KbStorage } from './storage';

interface CleanupLogger {
  warn(message: string): void;
}

/**
 * 删除对象存储中的知识库文件。DB 删除已经成功，这里绝不能抛错把请求变成失败：
 * 返回失败的 key，由调用方展示/记审计，后续可据此清理孤儿对象。
 */
export async function cleanupStorageObjects(
  storage: KbStorage,
  keys: string[],
  logger: CleanupLogger,
): Promise<{ failed: string[] }> {
  if (keys.length === 0) return { failed: [] };
  try {
    const failed = await storage.deleteObjects(keys);
    if (failed.length > 0) {
      logger.warn(`对象存储清理部分失败 ${failed.length}/${keys.length}: ${failed.join(',')}`);
    }
    return { failed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`对象存储清理失败 ${keys.length} 个: ${msg}`);
    return { failed: keys };
  }
}
