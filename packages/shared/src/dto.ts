export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * BFF 按运行时解密的厂商路由。
 * 只在下发给 runtime 的请求体中出现，绝不下发到浏览器。
 */
export interface RunModelRoute {
  model: string;
  baseUrl: string;
  apiKey: string;
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

export interface CreateSessionRequest {
  title?: string;
  /** 新建任务时选定的模型；缺省用运营端默认模型。 */
  model?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  /** 会话固定使用的模型；历史会话在首次运行后回填。 */
  model: string | null;
}

export interface MessageDto {
  id: string;
  role: ChatRole;
  content: string;
  seq: number;
}

export interface CreateTaskRequest {
  goal: string;
}

export type ArtifactKind = 'docx' | 'xlsx' | 'pptx';

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

/** `/kb` 页列表项。 */
export interface KbDocDto {
  id: string;
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

export interface AdminMessageDto extends MessageDto {
  createdAt: string;
}

export interface AdminTaskItemDto {
  id: string;
  sessionId: string;
  goal: string;
  status: string;
  latestRunStatus: string | null;
  createdAt: string;
}

export interface AdminRunItemDto {
  id: string;
  status: string;
  startedAt: string;
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
  traceId: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  steps: PageDto<AdminStepDto>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    credits: number | null;
    status: string;
    models: unknown;
  } | null;
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
