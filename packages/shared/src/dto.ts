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
