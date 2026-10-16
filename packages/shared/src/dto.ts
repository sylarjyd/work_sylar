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
