import type { RunResume, RunStatus } from './protocol';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** 用户消息的多模态附件；历史消息按预算携带内容，缺省表示纯文本。 */
  attachments?: ChatAttachment[];
}

/**
 * 附件分类：text 覆盖纯文本与可抽取正文的文档（PDF/Word/Excel）；
 * image/audio/video 以原始字节交给支持对应模态的模型。
 */
export const ATTACHMENT_KINDS = ['text', 'image', 'audio', 'video'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const ATTACHMENT_KIND_LABELS: Record<AttachmentKind, string> = {
  text: '文本',
  image: '图片',
  audio: '音频',
  video: '视频',
};

/** 单条消息附件数量上限。 */
export const ATTACHMENT_MAX_PER_MESSAGE = 10;

export interface AttachmentSpec {
  /** 单文件上限；文本类含可抽取正文的文档。 */
  maxBytes: number;
  extensions: readonly string[];
  /** 扩展名 → 规范 MIME；服务端按此保存与回放，不信任客户端声明。 */
  mimeByExtension: Record<string, string>;
}

const TEXT_MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  log: 'text/plain',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
};

const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

export const ATTACHMENT_SPECS: Record<AttachmentKind, AttachmentSpec> = {
  text: { maxBytes: 10 * 1024 * 1024, extensions: Object.keys(TEXT_MIME), mimeByExtension: TEXT_MIME },
  image: { maxBytes: 10 * 1024 * 1024, extensions: Object.keys(IMAGE_MIME), mimeByExtension: IMAGE_MIME },
  audio: { maxBytes: 20 * 1024 * 1024, extensions: Object.keys(AUDIO_MIME), mimeByExtension: AUDIO_MIME },
  video: { maxBytes: 30 * 1024 * 1024, extensions: Object.keys(VIDEO_MIME), mimeByExtension: VIDEO_MIME },
};

/** 客户端 `accept` 属性用的扩展名清单。 */
export const ATTACHMENT_ACCEPT = ATTACHMENT_KINDS.flatMap((k) =>
  ATTACHMENT_SPECS[k].extensions.map((ext) => `.${ext}`),
).join(',');

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/**
 * 识别附件类别：扩展名决定是否受支持，MIME 仅用于消歧（webm 同时属于音频/视频）。
 * 未知扩展名即使声明了受支持的 MIME 也拒绝，避免把可执行/HTML 内容伪装成媒体回放。
 */
export function attachmentKindFor(filename: string, mime?: string): AttachmentKind | null {
  const ext = extensionOf(filename);
  const extKinds = ATTACHMENT_KINDS.filter((k) =>
    ATTACHMENT_SPECS[k].extensions.includes(ext),
  );
  if (extKinds.length === 0) return null;
  const normalizedMime = mime?.split(';')[0]?.trim().toLowerCase() ?? '';
  const mimeKind = ATTACHMENT_KINDS.find((k) =>
    Object.values(ATTACHMENT_SPECS[k].mimeByExtension).includes(normalizedMime),
  );
  return mimeKind && extKinds.includes(mimeKind) ? mimeKind : extKinds[0];
}

/** 按扩展名给出规范 MIME；仅用于已通过 attachmentKindFor 的文件。 */
export function attachmentMimeFor(filename: string, kind: AttachmentKind): string {
  return ATTACHMENT_SPECS[kind].mimeByExtension[extensionOf(filename)] ?? 'application/octet-stream';
}

export function attachmentKindLabel(kind: AttachmentKind): string {
  return ATTACHMENT_KIND_LABELS[kind] ?? kind;
}

/** 附件元数据；列表与消息回放共用，不含存储 Key。 */
export interface AttachmentRef {
  id: string;
  kind: AttachmentKind;
  filename: string;
  mime: string;
  size: number;
}

/** 上传成功后返回给客户端的附件。 */
export interface AttachmentDto extends AttachmentRef {
  createdAt: string;
}

/**
 * 下发给 runtime 的附件：data 为 base64，缺省表示因预算未随本次运行发送。
 * 文本类附件由 runtime 抽取正文，二进制附件按模型模态组装 content parts。
 */
export interface ChatAttachment {
  kind: AttachmentKind;
  filename: string;
  mime: string;
  size: number;
  data?: string;
}

/**
 * BFF 按运行时解密的厂商路由。
 * 只在下发给 runtime 的请求体中出现，绝不下发到浏览器。
 */
export interface RunModelRoute {
  model: string;
  baseUrl: string;
  apiKey: string;
  /** 该模型支持的输入模态；缺省按 text，供 runtime 过滤不支持多模态的回退路由。 */
  modalities?: ModelModality[];
}

/**
 * web → bff → runtime 的「下达目标」请求。
 * runId 由 BFF 生成并透传给 runtime，保证落库（run/step）与 SSE 事件流对齐。
 */
export interface RunRequest {
  runId: string;
  sessionId: string;
  /** 产物存储 Key 需按租户隔离；BFF 从 JWT 取出后透传给 runtime。 */
  tenantId: string;
  /** 知识库按 tenant_id + user_id 隔离；BFF 从 JWT 的 sub 透传。 */
  userId: string;
  goal: string;
  messages: ChatMessage[];
  /** 预占额度、允许模型与价格；缺省表示不限预算（测试/兼容）。 */
  billing?: RunBilling;
  /** 管理端参数配置；缺省或非法值由 runtime 夹取。 */
  config?: RunConfig;
  /** 本次运行可用的模型路由（按优先级）；缺省时 runtime 使用启动时的静态网关。 */
  modelRoutes?: RunModelRoute[];
  /** 自定义助手的系统提示词；非空时由 runtime 作为首条 system 消息注入。 */
  systemPrompt?: string;
  /** 本次运行允许的内置工具名；缺省表示不限制，空数组表示禁用全部内置工具。 */
  enabledTools?: string[];
  /** 助手权限模式；缺省按标准模式（各工具自身的 safe/confirm/blocked）。 */
  permissionMode?: AssistantPermissionMode;
  /** 助手绑定的知识库；缺省或空数组表示检索全部知识库。 */
  kbIds?: string[];
  /** 断点续跑：由 BFF 从 RunCheckpoint 读出后下发。 */
  resume?: RunResume;
  /** 任务分类：办公/开发模式在没有任何产出物时由 runtime 兜底落一份结果文件。 */
  mode?: SessionMode;
}

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthUser {
  id: string;
  email: string;
  /** 角色：v1 单人部署恒为 'admin'；多租户真实角色属后续。 */
  role: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

/** 任务分类：决定运行时的行为取向（对话直答 / 办公多步任务 / 开发编码）。 */
export const SESSION_MODES = ['chat', 'task', 'code'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export function isSessionMode(v: unknown): v is SessionMode {
  return typeof v === 'string' && (SESSION_MODES as readonly string[]).includes(v);
}

export const SESSION_MODE_LABELS: Record<SessionMode, string> = {
  chat: '对话',
  task: '办公',
  code: '开发',
};

export interface CreateSessionRequest {
  title?: string;
  /** 新建任务时选定的模型；缺省用助手默认模型，再缺省用运营端默认模型。 */
  model?: string;
  /** 新建任务时选定的自定义助手；缺省使用默认助手。 */
  assistantId?: string;
  /** 任务分类；缺省按对话处理。会话创建后固定，运行期按分类引导助手行为。 */
  mode?: SessionMode;
}

export interface UpdateSessionRequest {
  /** 新标题；改名后自动命名不再覆盖。 */
  title?: string;
  /** 置顶开关。 */
  pinned?: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  /** 会话固定使用的模型；历史会话在首次运行后回填。 */
  model: string | null;
  /** 会话绑定的助手；助手被删除后为空。 */
  assistantId: string | null;
  assistantName: string | null;
  /** 任务分类；存量会话创建时没有该字段，读取时归一为对话。 */
  mode: SessionMode;
  /** 用户置顶；列表按置顶优先排序。 */
  pinned: boolean;
}

/** 历史会话列表默认每页条数；侧栏首屏与下滑翻页共用同一口径。 */
export const SESSION_PAGE_SIZE = 20;

export interface SessionPage {
  items: SessionSummary[];
  /** 下一页游标；为空表示已到末尾。 */
  nextCursor: string | null;
}

export interface MessageDto {
  id: string;
  role: ChatRole;
  content: string;
  seq: number;
  attachments: AttachmentRef[];
}

export interface CreateTaskRequest {
  goal: string;
  /** 已上传且未使用的附件 id；按上传顺序绑定到本次用户消息。 */
  attachmentIds?: string[];
}

/**
 * 成果类型：docx/xlsx/pptx 为结构化文档；text 为代码、Markdown、CSV 等文本文件，
 * 具体格式由 filename 的扩展名决定，下载时按纯文本返回。
 */
export type ArtifactKind = 'docx' | 'xlsx' | 'pptx' | 'text';

/** 工具产出物的引用；`artifact` step 的 payload 即此类型。 */
export interface ArtifactRef {
  kind: ArtifactKind;
  filename: string;
  storageKey: string;
  size: number;
}

/** 成果区列表项。 */
export interface ArtifactDto {
  id: string;
  kind: ArtifactKind;
  filename: string;
  size: number;
  version: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// M3 工具权限与确认
// ---------------------------------------------------------------------------

/** 工具权限等级：safe 直接执行；confirm 需用户确认；blocked 一律拒绝。 */
export type ToolPermission = 'safe' | 'confirm' | 'blocked';

/** `confirm_request` step 的 payload：用户需据此决定是否放行。 */
export interface ConfirmRequest {
  confirmId: string;
  tool: string;
  args: Record<string, unknown>;
}

/** BFF 确认端点的请求体。 */
export interface ConfirmDecision {
  confirmId: string;
  approved: boolean;
}

// ---------------------------------------------------------------------------
// M4a 知识库 RAG
// ---------------------------------------------------------------------------

/** 知识库文档摄取状态：pending 摄取中 / ready 可检索 / failed 失败。 */
export type KbDocStatus = 'pending' | 'ready' | 'failed';

/** 知识库摘要：客户端列表与运营端列表共用。 */
export interface KbBaseDto {
  id: string;
  name: string;
  description: string;
  docCount: number;
  readyCount: number;
  pendingCount: number;
  failedCount: number;
  chunkCount: number;
  /** 文档原始大小合计（字节）。 */
  totalBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface KbBaseInput {
  name: string;
  description?: string;
}

export type KbBasePatch = Partial<KbBaseInput>;

/** 删除结果：DB 已删除，cleanupFailed 表示对象存储清理失败的个数。 */
export interface KbDeleteResultDto {
  deletedDocs: number;
  cleanupFailed: number;
}

/** `/kb` 页文档项。 */
export interface KbDocDto {
  id: string;
  knowledgeBaseId: string;
  filename: string;
  mime: string;
  size: number;
  status: KbDocStatus;
  chunkCount: number;
  error: string | null;
  createdAt: string;
}

/** 一次检索命中：`kb.retrieve` 的切片级结果（docName + 切片序号 + 相似度 + 正文）。 */
export interface KbSearchHit {
  docName: string;
  seq: number;
  score: number;
  text: string;
}

// ---------------------------------------------------------------------------
// 自定义助手与技能
// ---------------------------------------------------------------------------

/** 记忆助手权限模式：标准按工具自身等级；只读禁止需确认的工具；自动自动放行需确认的工具。 */
export const ASSISTANT_PERMISSION_MODES = ['standard', 'readonly', 'auto'] as const;
export type AssistantPermissionMode = (typeof ASSISTANT_PERMISSION_MODES)[number];

export function isAssistantPermissionMode(v: unknown): v is AssistantPermissionMode {
  return typeof v === 'string' && (ASSISTANT_PERMISSION_MODES as readonly string[]).includes(v);
}

export const ASSISTANT_PERMISSION_MODE_LABELS: Record<AssistantPermissionMode, string> = {
  standard: '标准：写操作需确认',
  readonly: '只读：禁止写操作',
  auto: '自动：写操作自动放行',
};

export const ASSISTANT_PERMISSION_MODE_HINTS: Record<AssistantPermissionMode, string> = {
  standard: '代码执行、MCP 等有副作用的工具执行前需你确认。',
  readonly: '只允许联网检索、读取网页与知识库、生成文档等只读操作。',
  auto: '有副作用的工具自动执行，不再逐次确认；请仅在信任任务时使用。',
};

/** 内置技能：一个技能对应一组运行时工具。 */
export interface AssistantSkill {
  key: string;
  name: string;
  description: string;
  tools: readonly string[];
}

export const ASSISTANT_SKILLS: readonly AssistantSkill[] = [
  {
    key: 'web',
    name: '联网检索',
    description: '搜索互联网并读取网页正文',
    tools: ['web.search', 'web.fetch'],
  },
  {
    key: 'docs',
    name: '文档生成',
    description: '生成 Word、Excel、PPT 文件',
    tools: ['doc.docx', 'doc.xlsx', 'doc.pptx'],
  },
  {
    key: 'code',
    name: '代码执行',
    description: '在沙箱中运行脚本处理数据',
    tools: ['code.exec'],
  },
  {
    key: 'kb',
    name: '知识库检索',
    description: '检索已上传的私有资料并引用来源',
    tools: ['kb.retrieve'],
  },
] as const;

export type AssistantSkillKey = (typeof ASSISTANT_SKILLS)[number]['key'];

export const ASSISTANT_SKILL_KEYS: readonly string[] = ASSISTANT_SKILLS.map((s) => s.key);

/** 技能去重并按固定顺序输出，未知技能丢弃（仅用于读取存量数据）。 */
export function normalizeSkills(raw: readonly string[]): AssistantSkillKey[] {
  const set = new Set(raw);
  return ASSISTANT_SKILLS.filter((s) => set.has(s.key)).map((s) => s.key as AssistantSkillKey);
}

/** 把技能展开为运行时工具名（去重保序）；空技能返回空数组，表示禁用全部内置工具。 */
export function toolsForSkills(skills: readonly string[]): string[] {
  const allowed = new Set(toolsForSkillSet(skills));
  return [...allowed];
}

function toolsForSkillSet(skills: readonly string[]): string[] {
  const out: string[] = [];
  for (const skill of ASSISTANT_SKILLS) {
    if (!skills.includes(skill.key)) continue;
    out.push(...skill.tools);
  }
  return out;
}

export interface AssistantDto {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  permissionMode: AssistantPermissionMode;
  model: string | null;
  skills: AssistantSkillKey[];
  /** 绑定知识库 ID；空数组表示检索全部知识库。 */
  kbIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AssistantInput {
  name: string;
  description?: string;
  systemPrompt?: string;
  permissionMode?: AssistantPermissionMode;
  model?: string | null;
  skills?: string[];
  kbIds?: string[];
}

export type AssistantPatch = Partial<AssistantInput>;

// ---------------------------------------------------------------------------
// M4b 连接器 / MCP
// ---------------------------------------------------------------------------

/** 连接器对外 DTO（**不含 env**）；toolCount/lastValidatedAt 为上次校验快照。 */
export interface ConnectorDto {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  toolCount: number;
  lastValidatedAt: string | null;
  createdAt: string;
}

/** MCP 工具摘要（`tools/list` 的投影）。 */
export interface McpToolInfo {
  name: string;
  description: string;
  /** MCP 工具的入参 JSON-Schema，直接用作 `Tool.parameters`。 */
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// M5a 计费与网关
// ---------------------------------------------------------------------------

/** 模型价格：每千 token 的毫积分费率（1 积分 = 1000 毫积分）。 */
export interface ModelPriceDto {
  inputMilliCreditsPer1k: number;
  outputMilliCreditsPer1k: number;
}

/** 模型支持的模态；一个模型可同时支持多种（如文本输入 + 图片输入）。 */
export const MODEL_MODALITIES = ['text', 'image', 'audio', 'video'] as const;
export type ModelModality = (typeof MODEL_MODALITIES)[number];

/** 运营端与客户端共用的中文标签。 */
export const MODEL_MODALITY_LABELS: Record<ModelModality, string> = {
  text: '文本',
  image: '图片',
  audio: '音频',
  video: '视频',
};

/** 去重并按固定顺序输出，未知值直接丢弃（仅用于读取存量数据）。 */
export function normalizeModalities(raw: readonly string[]): ModelModality[] {
  const set = new Set(raw);
  return MODEL_MODALITIES.filter((m) => set.has(m));
}

/**
 * 模型能力分类：决定模型在业务中的用途（对话 / 向量化 / 重排 / 语音合成 / 语音识别）。
 * 与输入输出模态正交：一个对话模型可同时支持图片输入，一个 TTS 模型的输出是音频。
 */
export const MODEL_CAPABILITIES = ['chat', 'embedding', 'rerank', 'tts', 'asr'] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export const MODEL_CAPABILITY_LABELS: Record<ModelCapability, string> = {
  chat: '对话',
  embedding: 'Embedding',
  rerank: 'Rerank',
  tts: 'TTS',
  asr: 'ASR',
};

/** 去重并按固定顺序输出；未知值丢弃。空结果由调用方决定是否回退为 chat。 */
export function normalizeCapabilities(
  raw: readonly string[] | null | undefined,
): ModelCapability[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set(raw);
  return MODEL_CAPABILITIES.filter((c) => set.has(c));
}

/** 只有对话能力模型才能进入聊天模型选择器与默认模型。 */
export function isChatCapable(raw: readonly string[] | null | undefined): boolean {
  return Array.isArray(raw) && raw.includes('chat');
}

/** Web 端模型选择器的一项；不含 Base URL、密钥或内部 ID。 */
export interface ClientModelDto {
  model: string;
  displayName: string;
  providerName: string;
  /** 按固定顺序输出的模态标签。 */
  modalities: ModelModality[];
}

/** `GET /api/models` 响应：仅当前套餐可用的已启用模型。 */
export interface ClientModelsDto {
  models: ClientModelDto[];
  defaultModel: string | null;
}

/** BFF 下发给 runtime 的计费约束；缺省时不限预算（仅测试/兼容）。 */
export interface RunBilling {
  maxCredits: number;
  allowedModels: string[];
  /** 用户本次选中的模型；runtime 据此把它排到候选第一位。 */
  selectedModel?: string;
  prices: Record<string, ModelPriceDto>;
}

/** `usage` SSE 事件的 data：截至当前的累计用量，按模型拆分。 */
export interface UsageEvent {
  input: number;
  output: number;
  models: { model: string; input: number; output: number }[];
}

/** 套餐目录项。 */
export interface PlanDto {
  id: string;
  name: string;
  priceCents: number;
  monthlyBaseCredits: number;
  monthlyBonusCredits: number;
  maxCreditsPerRun: number;
  rpm: number;
  allowedModels: string[];
}

/** `/api/billing/summary` 响应。 */
export interface BillingSummaryDto {
  plan: PlanDto;
  subscription: { status: string; periodStart: string; periodEnd: string };
  /** 可用积分 = balance - reserved。 */
  balance: number;
  reserved: number;
  nextExpiry: { amount: number; expiresAt: string } | null;
}

/** 积分流水项。 */
export interface CreditLedgerItemDto {
  id: string;
  type: string;
  amount: number;
  source: string | null;
  runId: string | null;
  note: string | null;
  createdAt: string;
}

export interface CreditLedgerPageDto {
  items: CreditLedgerItemDto[];
  nextCursor: string | null;
}

/** `/api/billing/usage` 聚合项：key 为日期（YYYY-MM-DD）或模型名。 */
export interface UsageAggregateDto {
  key: string;
  credits: number;
  inputTokens: number;
  outputTokens: number;
  runs: number;
}

// ---------------------------------------------------------------------------
// M5b-1 管理端
// ---------------------------------------------------------------------------

/** 管理端统一 offset 分页响应。 */
export interface PageDto<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 运营端知识库列表项：在客户端摘要上补所有者与租户信息。 */
export interface AdminKbBaseItemDto extends KbBaseDto {
  tenantId: string;
  tenantName: string;
  userId: string;
  userEmail: string;
}

/** 运营端知识库详情：基础信息 + 文档分页。 */
export interface AdminKbBaseDetailDto extends AdminKbBaseItemDto {
  docs: PageDto<KbDocDto>;
}

/** 运营端知识库总览统计。 */
export interface AdminKbStatsDto {
  baseCount: number;
  docCount: number;
  readyCount: number;
  pendingCount: number;
  failedCount: number;
  chunkCount: number;
  totalBytes: number;
  tenantCount: number;
}

/** 删除知识库需输入库名精确确认。 */
export interface AdminKbDeleteInput {
  confirmName: string;
}

/** 删除文档需回传文档 ID 确认。 */
export interface AdminKbDocDeleteInput {
  confirmId: string;
}

export type UserStatus = 'active' | 'disabled';
export type UserRole = 'member' | 'admin';

export interface AdminUserItemDto {
  id: string;
  email: string;
  tenantId: string;
  tenantName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface AdminUserDetailDto extends AdminUserItemDto {
  planId: string | null;
  planName: string | null;
  subscriptionStatus: string | null;
  balance: number;
  reserved: number;
  sessionCount: number;
}

export interface AdminUserPatch {
  status?: UserStatus;
  role?: UserRole;
}

export interface AdminTenantItemDto {
  id: string;
  name: string;
  type: string;
  planId: string;
  planName: string;
  subscriptionStatus: string;
  balance: number;
  reserved: number;
  userCount: number;
  createdAt: string;
}

export interface AdminTenantDetailDto extends AdminTenantItemDto {
  sessionCount: number;
  billing: BillingSummaryDto;
}

export interface AdminPlanDto extends PlanDto {
  active: boolean;
  createdAt: string;
}

export interface AdminPlanInput {
  id: string;
  name: string;
  priceCents: number;
  monthlyBaseCredits: number;
  monthlyBonusCredits: number;
  maxCreditsPerRun: number;
  rpm: number;
  allowedModels: string[];
  active: boolean;
}

export type AdminPlanPatch = Partial<Omit<AdminPlanInput, 'id'>>;

/** 删除套餐必须回传与路径一致的标识，避免误触。 */
export interface AdminPlanDeleteInput {
  confirmId: string;
}

export interface AdminSessionItemDto {
  id: string;
  title: string;
  status: string;
  tenantId: string;
  userEmail: string;
  messageCount: number;
  taskCount: number;
  createdAt: string;
}

export interface AdminSessionDetailDto extends AdminSessionItemDto {
  artifactCount: number;
}

/** 运营端问答缓存条目：会话或用户缺失时回退展示原始 id。 */
export interface AdminQaCacheItemDto {
  hash: string;
  userId: string;
  userEmail: string;
  sessionId: string;
  sessionTitle: string;
  question: string;
  answer: string;
  createdAt: string;
  expiresAt: string;
}

export type AdminQaCacheListDto = PageDto<AdminQaCacheItemDto>;

export interface AdminMessageDto extends MessageDto {
  createdAt: string;
}

export interface AdminTaskItemDto {
  id: string;
  sessionId: string;
  goal: string;
  status: RunStatus;
  latestRunStatus: RunStatus | null;
  attempts: number;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface AdminRunItemDto {
  id: string;
  attempt: number;
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  credits: number | null;
}

export interface AdminTaskDetailDto extends AdminTaskItemDto {
  runs: AdminRunItemDto[];
}

export interface AdminStepDto {
  id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  ts: string;
}

export interface AdminRunDetailDto {
  id: string;
  taskId: string;
  attempt: number;
  traceId: string | null;
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  cancelRequestedAt: string | null;
  checkpoint: { round: number; seq: number; updatedAt: string } | null;
  steps: PageDto<AdminStepDto>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    credits: number | null;
    status: string;
    models: unknown;
  } | null;
}

export interface CancelRunResultDto {
  status: RunStatus;
}

export interface RetryRunResultDto {
  runId: string;
  taskId: string;
  attempt: number;
}

/** 运营端厂商（永不返回 apiKey 明文）。 */
export interface AdminModelProviderDto {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyHint: string | null;
  modelCount: number;
  createdAt: string;
}

/** 运营端模型目录项。 */
export interface AdminModelDto {
  model: string;
  displayName: string;
  providerId: string | null;
  providerName: string | null;
  enabled: boolean;
  /** 能力分类；只有包含 chat 的模型会出现在客户端的对话模型选择器中。 */
  capabilities: ModelCapability[];
  modalities: ModelModality[];
  sortOrder: number;
  inputMilliCreditsPer1k: number;
  outputMilliCreditsPer1k: number;
  isDefault: boolean;
  updatedAt: string;
}

/** 环境变量兜底 provider（仅展示分组名与模型名）。 */
export interface AdminLegacyProviderDto {
  name: string;
  models: string[];
}

export interface AdminModelsDto {
  providers: AdminModelProviderDto[];
  models: AdminModelDto[];
  defaultModel: string | null;
  /** active=true 表示数据库没有厂商，运行时使用环境变量兜底。 */
  fallback: { active: boolean; providers: AdminLegacyProviderDto[] };
}

export interface AdminModelTestResultDto {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export type SettingSource = 'db' | 'env' | 'default';

export type SettingType = 'number' | 'string' | 'boolean' | 'secret';

interface AdminSettingBaseDto {
  key: string;
  source: SettingSource;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface AdminNumberSettingDto extends AdminSettingBaseDto {
  type: 'number';
  value: number;
  min: number;
  max: number;
}

export interface AdminStringSettingDto extends AdminSettingBaseDto {
  type: 'string';
  value: string;
  maxLength: number;
}

export interface AdminBooleanSettingDto extends AdminSettingBaseDto {
  type: 'boolean';
  value: boolean;
}

export interface AdminSecretSettingDto extends AdminSettingBaseDto {
  type: 'secret';
  /** 永不回传明文：已配置时为脱敏串，未配置为 null。 */
  maskedValue: string | null;
  configured: boolean;
  maxLength: number;
}

export type AdminSettingDto =
  | AdminNumberSettingDto
  | AdminStringSettingDto
  | AdminBooleanSettingDto
  | AdminSecretSettingDto;

/** PUT 请求体 value：secret 传 null 表示显式清空。 */
export type AdminSettingValue = number | string | boolean | null;

export interface AdminAuditItemDto {
  id: string;
  actorId: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface AdminSubscribeRequest {
  planId: string;
}

export interface AdminCreditsRequest {
  amount: number;
  note?: string;
  expiresAt?: string | null;
}

/** 运行参数（BFF → runtime）；缺省或非法值由 runtime 夹取。 */
export interface RunConfig {
  maxRounds?: number;
  confirmTimeoutMs?: number;
  codeExecTimeoutMs?: number;
}

export interface HealthCheckDto {
  ok: boolean;
  latencyMs?: number;
  /** Redis 未配置时标记为跳过，不视为失败。 */
  skipped?: boolean;
  error?: string;
}

export interface HealthReadyDto {
  status: 'ready' | 'degraded';
  version: string;
  checks: {
    db: HealthCheckDto;
    redis: HealthCheckDto;
    runtime: HealthCheckDto;
  };
}

/** runtime `/metrics/summary`：按分钟窗口聚合的模型/MCP 观测数据。 */
export interface RuntimeModelSummaryDto {
  model: string;
  requests: number;
  errors: number;
  avgLatencyMs: number | null;
}

export interface RuntimeSummaryDto {
  /** 窗口内没有任何模型样本时为 insufficient_data，告警评估需跳过而不是误报。 */
  status: 'ok' | 'insufficient_data';
  windowMinutes: number;
  activeRuns: number;
  models: RuntimeModelSummaryDto[];
  fallbacks: number;
  mcpRestarts: number;
}

export type AdminOverviewRange = '24h' | '7d' | '30d';

export interface AdminOverviewKpiDto {
  runs: number;
  failedRuns: number;
  /** 已结束运行的成功率；窗口内没有已结束运行时为 null。 */
  successRate: number | null;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  unresolvedAlerts: number;
}

export interface AdminOverviewPointDto {
  bucketStart: string;
  runs: number;
  failedRuns: number;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  avgDurationMs: number | null;
}

export interface AdminOverviewModelCostDto {
  model: string;
  credits: number;
}

export interface AdminServiceHealthDto {
  name: string;
  up: boolean;
  checkedAt: string;
}

export interface AdminOverviewDto {
  range: AdminOverviewRange;
  current: AdminOverviewKpiDto;
  previous: AdminOverviewKpiDto;
  series: AdminOverviewPointDto[];
  modelCosts: AdminOverviewModelCostDto[];
  serviceHealth: AdminServiceHealthDto[];
  generatedAt: string;
}

export type AdminMetricGranularity = 'hour' | 'day';
export type AdminMetricDimensionType = 'global' | 'model' | 'tenant' | 'tool';

export interface AdminMetricPointDto {
  bucketStart: string;
  value: number;
  count: number;
}

export interface AdminMetricSeriesDto {
  metric: string;
  dimensionType: AdminMetricDimensionType;
  dimensionId: string;
  points: AdminMetricPointDto[];
}

export interface AdminMetricTimeseriesDto {
  from: string;
  to: string;
  granularity: AdminMetricGranularity;
  series: AdminMetricSeriesDto[];
}

export interface AdminAlertRuleDto {
  id: string;
  key: string;
  name: string;
  metric: string;
  comparator: 'gt' | 'lt';
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  severity: 'warning' | 'critical';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminAlertRulePatch {
  threshold?: number;
  windowMinutes?: number;
  cooldownMinutes?: number;
  severity?: 'warning' | 'critical';
  enabled?: boolean;
}

export interface AdminAlertEventDto {
  id: string;
  ruleId: string;
  ruleName: string;
  status: 'firing' | 'resolved';
  value: number;
  message: string;
  startedAt: string;
  resolvedAt: string | null;
  notifiedAt: string | null;
  deliveryStatus: 'sent' | 'failed' | 'skipped' | null;
  deliveryError: string | null;
}

export interface AdminAlertTestResultDto {
  deliveryStatus: 'sent' | 'failed' | 'skipped';
  deliveryError: string | null;
  notifiedAt: string | null;
}

export type AdminTimelineNodeKind =
  | 'accepted'
  | 'think'
  | 'tool'
  | 'confirm'
  | 'artifact'
  | 'notice'
  | 'finished';

export type AdminTimelineNodeStatus =
  | 'ok'
  | 'failed'
  | 'denied'
  | 'blocked'
  | 'running'
  | 'done';

export interface AdminTimelineNodeDto {
  /** step 事件用 step id；合成节点用 `${runId}:${kind}`，保证前端 key 稳定。 */
  id: string;
  kind: AdminTimelineNodeKind;
  label: string;
  status: AdminTimelineNodeStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

export interface AdminRunTimelineDto {
  runId: string;
  status: string;
  traceId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  nodes: AdminTimelineNodeDto[];
  /** 节点超过 500 时只返回前 500，并置为 true。 */
  truncated: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    credits: number | null;
    models: unknown;
  } | null;
}
