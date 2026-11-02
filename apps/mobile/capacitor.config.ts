import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 移动端复用线上工作台：WebView 直接加载 CAP_SERVER_URL。
 * 本地联调示例：CAP_SERVER_URL=http://10.0.2.2:3000 CAP_CLEARTEXT=1 pnpm cap sync
 */
const serverUrl = process.env.CAP_SERVER_URL ?? 'https://app.worksylar.com';
const allowCleartext = process.env.CAP_CLEARTEXT === '1';

const config: CapacitorConfig = {
  appId: 'com.worksylar.app',
  appName: 'WorkSylar',
  webDir: 'www',
  server: {
    url: serverUrl,
    cleartext: allowCleartext,
    androidScheme: allowCleartext ? 'http' : 'https',
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
  },
  ios: {
    contentInset: 'always',
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
