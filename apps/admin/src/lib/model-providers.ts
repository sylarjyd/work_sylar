/**
 * 常用模型厂商预设：只填「名称 + OpenAI 兼容 Base URL」，API Key 仍由管理员自己填。
 * 地址以厂商当前的 OpenAI 兼容入口为准；有变化时改这里即可，页面无需改动。
 */
export interface ProviderPreset {
  key: string;
  name: string;
  baseUrl: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  {
    key: 'dashscope',
    name: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  { key: 'moonshot', name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
  { key: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { key: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1' },
  { key: 'ark', name: '火山方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { key: 'hunyuan', name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1' },
  { key: 'qianfan', name: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2' },
  { key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { key: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { key: 'ollama', name: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1' },
  { key: 'vllm', name: 'vLLM（自建）', baseUrl: 'http://localhost:8000/v1' },
];

export function presetByKey(key: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.key === key);
}

/** 已保存的厂商地址能对上预设时，编辑弹窗回显对应选项。 */
export function presetKeyOfBaseUrl(baseUrl: string): string | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  return PROVIDER_PRESETS.find((preset) => preset.baseUrl === normalized)?.key;
}
