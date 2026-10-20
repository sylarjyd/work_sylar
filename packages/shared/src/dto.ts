export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
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
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
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

/** BFF 下发给 runtime 的计费约束；缺省时不限预算（仅测试/兼容）。 */
export interface RunBilling {
  maxCredits: number;
  allowedModels: string[];
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

export interface AdminModelProviderDto {
  /** provider 标识（取 apiKeyEnv 名；单模型配置为 default）；不含任何密钥。 */
  name: string;
  models: string[];
}

export interface AdminModelPriceDto extends ModelPriceDto {
  model: string;
  updatedAt: string;
}

export interface AdminModelsDto {
  providers: AdminModelProviderDto[];
  prices: AdminModelPriceDto[];
}

export type SettingSource = 'db' | 'env' | 'default';

export interface AdminSettingDto {
  key: string;
  value: number;
  source: SettingSource;
  updatedAt: string | null;
  updatedBy: string | null;
  min: number;
  max: number;
}

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
