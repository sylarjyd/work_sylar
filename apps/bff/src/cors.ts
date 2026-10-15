import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * web（:3000）与 bff（:4000）在开发下不同源，浏览器需要 CORS 放行。
 * main.ts 与测试共用这一份配置：测试若自行写一遍，就会与生产配置漂移，
 * 从而漏掉"生产漏开 CORS"这类只有真实浏览器才暴露的问题。
 */
export const CORS_OPTIONS: CorsOptions = { origin: true };
