'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Tabs } from 'antd';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_PER_MESSAGE,
  SESSION_MODES,
  SESSION_MODE_LABELS,
  SESSION_PAGE_SIZE,
  attachmentKindLabel,
  type AgentEvent,
  type ArtifactDto,
  type AssistantDto,
  type AttachmentDto,
  type AttachmentKind,
  type ClientModelDto,
  type MessageDto,
  type RunStatus,
  type SessionMode,
  type SessionSummary,
  type UpdateSessionRequest,
} from '@ai-office/shared';
import { AppShell } from '../components/app-shell';
import { ArtifactDrawer } from '../components/artifact-drawer';
import { Markdown } from '../components/markdown';
import {
  IconArrowUpRight,
  IconCheck,
  IconChevron,
  IconCopy,
  IconFile,
  IconPlus,
  IconSend,
  IconSpark,
  IconTool,
  IconX,
} from '../components/icons';
import { errorText } from '@ai-office/web-core';
import {
  consumeRunStream,
  type RunStreamHandlers,
  type RunStreamState,
} from '../lib/run-stream';
import { RunTracker, type RunAttachment } from '../lib/run-tracker';
import {
  cancelRun,
  confirmRun,
  createSession,
  deleteAttachment,
  deleteSession,
  downloadArtifact,
  getSession,
  getToken,
  isUnauthorized,
  listArtifacts,
  listAssistants,
  listModels,
  listSessionMessages,
  listSessions,
  streamRun,
  streamTask,
  updateSession,
  uploadAttachment,
} from '../lib/api';
import {
  checkFiles,
  fileRejectText,
  formatBytes,
  modalityWarning,
  unsupportedModalities,
} from '../lib/attachments';
import { currentConfirmCard } from '../lib/pending-confirm';
import { renderStep } from '../lib/render-step';
import { sortSessions } from '../lib/session-filter';

/** 尚未发送的附件：先本地展示，上传完成后再拿服务端 id。 */
interface PendingAttachment {
  localId: string;
  filename: string;
  kind: AttachmentKind;
  size: number;
  status: 'uploading' | 'ready' | 'error';
  dto?: AttachmentDto;
  previewUrl?: string;
  error?: string;
}

interface SuggestionCategory {
  key: string;
  label: string;
  questions: { label: string; goal: string }[];
}

const CHAT_SUGGESTIONS = [
  { label: '写一份周报', goal: '整理本周工作进展，生成一份周报文档' },
  { label: '调研竞品', goal: '调研竞品并给出结论' },
  { label: '做一张数据表', goal: '把项目数据整理成表格，包含汇总与趋势' },
  { label: '生成演示稿', goal: '根据项目方案生成一份演示稿' },
];

/** 办公/开发的常见问题分类与推荐问题，参考 WorkBuddy 首页的分类组织方式。 */
const MODE_SUGGESTION_CATEGORIES: Partial<Record<SessionMode, SuggestionCategory[]>> = {
  task: [
    {
      key: 'doc',
      label: '文档处理',
      questions: [
        {
          label: '把 Markdown 转成精美 PDF',
          goal: '帮我把上传的 Markdown 文件转换成排版精美的 PDF 文档：包含封面、目录、代码高亮、表格交替底色和页码。',
        },
        {
          label: '整理本周工作周报',
          goal: '整理本周工作进展，生成一份结构化的周报文档，包含已完成事项、风险与下周计划。',
        },
        {
          label: '会议纪要转正式文档',
          goal: '把会议纪要整理成结构清晰的 Word 文档，列出结论、待办事项与负责人。',
        },
      ],
    },
    {
      key: 'data',
      label: '数据分析及可视化',
      questions: [
        {
          label: '做退休计划测算工具',
          goal: '帮我创建一个易于使用的退休计划工具，面向金融新手，支持复利计算并把结果可视化。',
        },
        {
          label: '销售数据分析报告',
          goal: '分析这份销售数据，产出带汇总与趋势图表的 Excel 分析报告。',
        },
        {
          label: '项目数据看板',
          goal: '把项目数据整理成表格并生成可视化看板，包含汇总与趋势。',
        },
      ],
    },
    {
      key: 'research',
      label: '深度研究',
      questions: [
        {
          label: '对比全球 10 个 AI 模型',
          goal: '请研究 2026 年全球表现最优的 10 个 AI 模型，对比分析它们在编码、多模态等关键能力上的表现，并总结各自的技术特点和优势场景。',
        },
        {
          label: '调研竞品并输出结论',
          goal: '调研竞品并输出结论：功能对比矩阵、用户评价、差异化与机会点。',
        },
        {
          label: '猎豹种群保护现状',
          goal: '研究非洲草原猎豹种群的生存困境与保护现状，输出一份研究报告。',
        },
      ],
    },
    {
      key: 'slides',
      label: '幻灯片',
      questions: [
        {
          label: '生成 AI Agent 趋势 PPT',
          goal: '请生成一个 AI Agent 2026 年发展趋势的 PPT。',
        },
        {
          label: '项目方案演示稿',
          goal: '根据项目方案生成一份演示稿，包含背景、目标、方案与里程碑。',
        },
        {
          label: '季度经营汇报',
          goal: '根据经营数据生成一份季度汇报演示稿，突出增长、问题与下一步计划。',
        },
      ],
    },
  ],
  code: [
    {
      key: 'daily',
      label: '日常开发',
      questions: [
        {
          label: '开发日程管理应用',
          goal: '开发一个日程管理应用，可以创建、编辑、删除待办事项，支持邮箱密码注册登录和 Google 登录。',
        },
        {
          label: '批量重命名脚本',
          goal: '用 Node.js 写一个批量重命名文件的脚本，支持按规则预览与回滚。',
        },
        {
          label: '文件上传接口',
          goal: '实现一个文件上传接口，支持分片上传、断点续传与进度回调。',
        },
      ],
    },
    {
      key: 'web',
      label: '网站开发',
      questions: [
        {
          label: 'AI 热点信息追踪网页',
          goal: '做一个大模型实时信息追踪网页，自动检索海外和中国的主流模型、AI 应用公司的最新动态，每天自动更新。页面分两层：首页按日期展示当天的资讯总结，点进去可以看到具体的资讯详情。',
        },
        {
          label: '个人博客网站',
          goal: '我想做一个个人博客网站，用来记录和分享生活。希望支持 Google 登录，并且可以方便地创建、编辑和修改文章，博客内容采用 Markdown 格式展示。',
        },
        {
          label: '企业官网首页',
          goal: '做一个企业官网首页，包含产品介绍、客户案例与联系我们，并适配手机端。',
        },
      ],
    },
    {
      key: 'agent',
      label: 'Agent 应用',
      questions: [
        {
          label: '知识库客服 Agent',
          goal: '做一个客服 Agent 应用，能读取知识库回答售后问题，答不上来时转人工。',
        },
        {
          label: '自动日报 Agent',
          goal: '做一个自动生成日报的 Agent：每天汇总数据、生成摘要并推送到邮箱。',
        },
        {
          label: '接入 MCP 工具服务',
          goal: '给 Agent 接入一个 MCP 服务，让它可以查询和更新内部工单系统。',
        },
      ],
    },
    {
      key: 'skill',
      label: 'Skill 开发',
      questions: [
        {
          label: '合同条款抽取 Skill',
          goal: '开发一个自定义 Skill：读取指定文件夹的合同，抽取关键条款并生成汇总表。',
        },
        {
          label: '网页抓取 Skill',
          goal: '开发一个网页抓取 Skill，把目标页面的正文和表格提取为 Markdown。',
        },
        {
          label: '数据清洗 Skill',
          goal: '开发一个数据清洗 Skill，自动识别重复行、空值和格式异常并输出清洗报告。',
        },
      ],
    },
  ],
};

const HERO_SUB: Record<SessionMode, string> = {
  chat: '把目标交给智能体：它会调研、写文档、做表格、生成演示稿。',
  task: '把目标交给智能体：它会调研、写文档、做表格、生成演示稿。',
  code: '描述要开发的应用，智能体会规划步骤、编写代码并把完整源码保存成文件。',
};

/** 无条目时的稳定空值，避免每次渲染新建引用。 */
const NO_EVENTS: AgentEvent[] = [];
const NO_ATTACHMENTS: RunAttachment[] = [];
const NO_DECISIONS: Record<string, boolean> = {};

function EventRow({
  ev,
  expectedModel,
  onOpenArtifacts,
}: {
  ev: AgentEvent;
  expectedModel: string;
  onOpenArtifacts: () => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [expanded, setExpanded] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const text = renderStep(ev);
  // 工具参数默认折叠：调用内容往往又长又散，平铺会淹没对话主线。
  const toolArgs = ev.type === 'tool_call' ? ev.payload.args : undefined;
  const hasToolArgs = toolArgs != null && JSON.stringify(toolArgs) !== '{}';

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  if (!text) return null;

  let meta = '事件';
  let iconCls = 'tool';
  let icon = <IconTool size={15} />;

  if (ev.type === 'think') {
    const actual = typeof ev.payload.model === 'string' ? ev.payload.model : '';
    meta = actual
      ? expectedModel && actual !== expectedModel
        ? `思考 · ${actual}（已自动切换）`
        : `思考 · ${actual}`
      : '思考';
    iconCls = 'think';
    icon = <IconSpark size={15} />;
  } else if (ev.type === 'tool_call') {
    meta = '工具调用';
    iconCls = 'tool';
    icon = <IconTool size={15} />;
  } else if (ev.type === 'tool_result') {
    meta = '工具结果';
    if (ev.payload.ok) {
      iconCls = 'tool';
      icon = <IconCheck size={15} />;
    } else {
      iconCls = 'result fail';
      icon = <IconX size={15} />;
    }
  } else if (ev.type === 'artifact') {
    meta = '文档产出';
    iconCls = 'artifact';
    icon = <IconFile size={15} />;
  }

  async function copy() {
    let next: 'copied' | 'failed' = 'copied';
    try {
      await navigator.clipboard.writeText(text ?? '');
    } catch {
      // 内网 HTTP 或权限被拒时退化为可见的失败提示，不打断对话流。
      next = 'failed';
    }
    setCopyState(next);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1500);
  }

  const copyLabel =
    copyState === 'copied'
      ? `已复制${meta}内容`
      : copyState === 'failed'
        ? `复制${meta}内容失败`
        : `复制${meta}内容`;

  return (
    <div className="wb-event">
      <div className={`wb-event-icon ${iconCls}`}>{icon}</div>
      <div className="wb-event-body">
        <div className="wb-event-meta">{meta}</div>
        {ev.type === 'tool_call' && hasToolArgs ? (
          <>
            <button
              type="button"
              className="wb-event-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              <span className="wb-event-summary">调用工具 {String(ev.payload.tool ?? '')}</span>
              <IconChevron size={14} className="wb-event-caret" />
            </button>
            {expanded && (
              <pre className="wb-event-detail">{JSON.stringify(toolArgs, null, 2)}</pre>
            )}
          </>
        ) : (
          <div className="wb-event-text">{text}</div>
        )}
        {ev.type === 'artifact' && (
          <button type="button" className="wb-event-action" onClick={onOpenArtifacts}>
            查看成果
            <IconArrowUpRight size={13} />
          </button>
        )}
      </div>
      <button
        type="button"
        className={`wb-copy${copyState === 'failed' ? ' failed' : ''}`}
        onClick={() => void copy()}
        aria-label={copyLabel}
        title={copyLabel}
      >
        {copyState === 'copied' ? (
          <IconCheck size={14} />
        ) : copyState === 'failed' ? (
          <IconX size={14} />
        ) : (
          <IconCopy size={14} />
        )}
      </button>
    </div>
  );
}

/** 助手正文与历史消息共用同一套 Markdown 排版；live 表示仍在流式追加。 */
function AssistantBubble({ text, live = false }: { text: string; live?: boolean }) {
  if (!text) return null;
  return (
    <div className={`wb-assistant-msg${live ? ' wb-assistant-live' : ''}`}>
      <span className="wb-assistant-avatar" aria-hidden="true">
        <IconSpark size={16} />
      </span>
      <div className="wb-assistant-text wb-assistant-md">
        <Markdown>{text}</Markdown>
      </div>
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  // 异步回调（删除后切换、自动命名补拉）需要最新列表，避免闭包里拿到旧值。
  const sessionsRef = useRef<SessionSummary[]>([]);
  // 侧栏分页：首屏 20 条，滚动到底用游标续拉；新建会话只前插，不动游标。
  const [sessionsCursor, setSessionsCursor] = useState<string | null>(null);
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  // 滚动事件可能在重渲染前连发，用 ref 同步占位防止同一游标被并发请求两次。
  const sessionsLoadingRef = useRef(false);
  const [sessionId, setSessionId] = useState<string>('');
  const [goal, setGoal] = useState('');
  // 历史消息：切换/打开会话时回填，新一轮运行只追加到 events，不回写这里。
  const [history, setHistory] = useState<MessageDto[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactDto[]>([]);
  const [error, setError] = useState('');
  // 运行态按会话存放在纯 TS 表里：切走不中断，切回直接渲染该会话条目。
  const [, bumpTrackerVersion] = useState(0);
  const trackerRef = useRef<RunTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = new RunTracker(() => bumpTrackerVersion((v) => v + 1));
  }
  const tracker = trackerRef.current;
  // 同一会话同一时刻最多一条被消费的流：起跑与回放挂回都先占位。
  const streamingRef = useRef(new Set<string>());
  // 事件回调可能在用户切走之后才到达：用它判断「当前查看的会话」，避免给别的会话刷新页面级视图。
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [models, setModels] = useState<ClientModelDto[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  // 运营端默认模型：历史会话（model 为空）首次运行前展示的就是它。
  const [defaultModel, setDefaultModel] = useState('');
  const [modelsLoaded, setModelsLoaded] = useState(false);
  // 自定义助手：仅新建任务（草稿态）可选择，会话创建后助手固定。
  const [assistants, setAssistants] = useState<AssistantDto[]>([]);
  const [selectedAssistantId, setSelectedAssistantId] = useState('');
  // 任务分类：随会话创建固定，运行期由 BFF 追加对应取向的提示词。
  const [selectedMode, setSelectedMode] = useState<SessionMode>('chat');
  // 首页推荐问题的当前分类；空值表示取该任务类型的第一个分类。
  const [categoryKey, setCategoryKey] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // 左侧问题导航当前高亮的问题 id（历史消息用 m.id，尚未落库的当轮用 pending）。
  const [activeAnchor, setActiveAnchor] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<PendingAttachment[]>([]);
  const addFilesRef = useRef<(files: File[]) => void>(() => undefined);
  // 所有由本页创建的 object URL 统一登记，卸载时兜底释放，避免长期占用 blob 内存。
  const objectUrlsRef = useRef(new Set<string>());
  const artifactReqRef = useRef(0);
  // 历史消息请求序号与已加载会话：快速切换时丢弃迟到响应，重复点击不重复请求。
  const historyReqRef = useRef(0);
  const loadedHistoryRef = useRef('');
  const lastUserScrollRef = useRef(0);
  pendingRef.current = pendingAttachments;

  // 当前会话视图：由 tracker 快照派生，事件/正文/决策都跟着会话走。
  const view = sessionId ? tracker.snapshot(sessionId) : null;
  const events = view?.events ?? NO_EVENTS;
  const liveText = view?.liveText ?? '';
  const decisions = view?.decisions ?? NO_DECISIONS;
  const submittedGoal = view?.goal ?? '';
  const submittedAttachments = view?.attachments ?? NO_ATTACHMENTS;
  const queuePosition = view?.queuePosition ?? null;
  const stopping = !!view && !view.terminal && view.status === 'stopping';
  const runId = view?.runId ?? '';
  const running = !!view && !view.terminal;
  // 视觉阶段映射回 RunStatus：终结后用于展示「已取消」等收尾文案。
  const runStatus: RunStatus | null = view
    ? view.terminal
      ? view.finalStatus
      : view.status === 'queued'
        ? 'queued'
        : 'running'
    : null;
  // prepare 已把本轮提问落库：刷新或切回后历史里也有同一条，同一份提问只渲染一次（优先历史）。
  // 纯附件轮没有正文，按附件 id 是否已全部出现在最后一条用户消息里判断。
  const lastHistoryMsg = history[history.length - 1];
  const pendingEchoed =
    !!view &&
    !view.terminal &&
    lastHistoryMsg?.role === 'user' &&
    (submittedGoal !== ''
      ? lastHistoryMsg.content === submittedGoal
      : submittedAttachments.length > 0 &&
        submittedAttachments.every((a) =>
          lastHistoryMsg.attachments.some((x) => x.id === a.id),
        ));
  const showPendingTurn = !!view && !pendingEchoed;

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // 切换任务类型后旧分类可能不存在，回到该类型的首个分类。
  useEffect(() => {
    setCategoryKey('');
  }, [selectedMode]);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    // 从其它菜单页点击历史会话会带 ?session= 回到工作台。
    const preferred = new URLSearchParams(window.location.search).get('session') ?? '';
    void refresh(preferred);
    void refreshModels();
    void refreshAssistants();
  }, [router]);

  // 直接粘贴文件（截图/复制的图片、音视频）即上传；文本粘贴仍走 textarea 默认行为。
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (running) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      addFilesRef.current(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [running]);

  useEffect(
    () => () => {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
    },
    [],
  );

  async function refreshAssistants() {
    try {
      setAssistants(await listAssistants());
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      // 助手加载失败不应阻断主流程：默认助手仍可用。
      setError(errorText(err));
    }
  }

  async function refreshModels() {
    try {
      const data = await listModels();
      setModels(data.models);
      const fallback = data.defaultModel ?? data.models[0]?.model ?? '';
      setDefaultModel(fallback);
      setSelectedModel((prev) => {
        if (prev && data.models.some((m) => m.model === prev)) return prev;
        return fallback;
      });
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    } finally {
      setModelsLoaded(true);
    }
  }

  async function refresh(preferred = '') {
    try {
      const page = await listSessions({ limit: SESSION_PAGE_SIZE });
      setSessions(page.items);
      setSessionsCursor(page.nextCursor);
      let pick = preferred ? page.items.find((s) => s.id === preferred) : undefined;
      if (preferred && !pick) {
        // 深链的旧会话可能在首屏之外：补拉摘要，避免误开最新会话。
        try {
          const fetched = await getSession(preferred);
          pick = fetched;
          setSessions((prev) => [fetched, ...prev]);
        } catch (err) {
          if (isUnauthorized(err)) {
            router.push('/login');
            return;
          }
          // 会话已归档或不存在：与历史行为一致，打开最新会话。
        }
      }
      // 只有显式指定会话（跨页面跳回）才自动打开；普通进入保持草稿，任务类型可切换。
      if (pick) {
        setSessionId(pick.id);
        if (pick.model) setSelectedModel(pick.model);
        void loadHistory(pick.id);
        // 刷新前就在跑的会话：relay 会回放已落库步骤并接续实时事件。
        if (pick.activeRun) void attachRun(pick.id, pick.activeRun.id);
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    }
  }

  async function loadMoreSessions() {
    if (sessionsLoadingRef.current || sessionsCursor === null) return;
    sessionsLoadingRef.current = true;
    setSessionsLoadingMore(true);
    try {
      const page = await listSessions({ limit: SESSION_PAGE_SIZE, cursor: sessionsCursor });
      // 深链补拉的旧会话可能也出现在后续分页里，按 id 去重避免侧栏出现两条。
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...page.items.filter((s) => !seen.has(s.id))];
      });
      setSessionsCursor(page.nextCursor);
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    } finally {
      sessionsLoadingRef.current = false;
      setSessionsLoadingMore(false);
    }
  }

  async function loadHistory(sid: string) {
    if (!sid) return;
    const req = ++historyReqRef.current;
    try {
      const list = await listSessionMessages(sid);
      if (req !== historyReqRef.current) return;
      loadedHistoryRef.current = sid;
      setHistory(list);
      stickToBottomRef.current = true;
    } catch (err) {
      if (req !== historyReqRef.current) return;
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    }
  }

  async function refreshArtifacts(sid: string) {
    const req = ++artifactReqRef.current;
    if (!sid) {
      setArtifacts([]);
      return;
    }
    try {
      const list = await listArtifacts(sid);
      if (req !== artifactReqRef.current) return;
      setArtifacts(list);
    } catch (err) {
      if (req !== artifactReqRef.current) return;
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    }
  }

  useEffect(() => {
    // 跑流期间不刷新：新会话在建流时会 setSessionId 触发本 effect，若并发拉取会覆盖乐观卡片；
    // 结束后 running 归位，由本 effect 统一刷新落库产物（新会话与已有会话同一路径）。
    if (running) return;
    void refreshArtifacts(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, running]);

  function trackUrl(url: string): void {
    objectUrlsRef.current.add(url);
  }

  function releaseUrl(url: string): void {
    URL.revokeObjectURL(url);
    objectUrlsRef.current.delete(url);
  }

  function discardPending(): void {
    for (const p of pendingRef.current) {
      if (p.previewUrl) releaseUrl(p.previewUrl);
    }
    pendingRef.current = [];
    setPendingAttachments([]);
  }

  function resetConversation() {
    setHistory([]);
    historyReqRef.current += 1;
    loadedHistoryRef.current = '';
    setError('');
    stickToBottomRef.current = true;
    artifactReqRef.current += 1;
    setArtifacts([]);
    discardPending();
  }

  /** 释放并清除某会话的内存条目；终态条目由落库历史接管时使用。 */
  function releaseEntry(id: string) {
    const entry = tracker.snapshot(id);
    if (entry) {
      for (const a of entry.attachments) if (a.previewUrl) releaseUrl(a.previewUrl);
    }
    tracker.clear(id);
  }

  /** 只丢弃已终结的条目：运行中的条目保留，后台流继续消费。 */
  function dropFinishedEntry(id: string) {
    const entry = tracker.snapshot(id);
    if (!entry?.terminal) return;
    releaseEntry(id);
  }

  /**
   * done 之后把实时条目交回落库历史：执行器在发布终态之前已写好 assistant 消息，
   * 因此这里拉到的历史是完整的。不交接的话，下一次发送覆盖条目时上一轮答案会从界面消失。
   * 拉取失败则保留实时条目，回答已经上屏，不应凭空消失。
   */
  async function settleIntoTimeline(id: string) {
    if (id !== sessionIdRef.current) return;
    const settledRunId = tracker.snapshot(id)?.runId ?? '';
    const req = ++historyReqRef.current;
    try {
      const list = await listSessionMessages(id);
      if (req !== historyReqRef.current || id !== sessionIdRef.current) return;
      // 等待期间可能已经起了新的一轮：只交接仍然是同一 run 的终态条目。
      const current = tracker.snapshot(id);
      if (!current || !current.terminal || current.runId !== settledRunId) return;
      loadedHistoryRef.current = id;
      setHistory(list);
      stickToBottomRef.current = true;
      releaseEntry(id);
    } catch {
      // 拉取失败保持实时视图。
    }
  }

  function handleSelect(id: string) {
    const needLoad = loadedHistoryRef.current !== id;
    if (id !== sessionId) {
      const target = sessions.find((s) => s.id === id);
      // 历史会话没有固化的模型：展示当前默认模型，实际运行由服务端按默认值解析。
      setSelectedModel(target?.model ?? defaultModel);
      // 已终结的条目由落库历史接管；运行中的条目继续在后台消费。
      dropFinishedEntry(id);
      setSessionId(id);
      resetConversation();
      if (needLoad) void loadHistory(id);
      // 刷新、断线或别的标签页发起的运行：按 activeRun 回放挂回。
      void ensureAttached(id);
      return;
    }
    if (needLoad) {
      // 同一会话回看：落库历史接管已结束的那一轮，避免同一轮展示两次。
      dropFinishedEntry(id);
      void loadHistory(id);
    }
  }

  function markUserScroll() {
    lastUserScrollRef.current = Date.now();
  }

  function handleNewSession() {
    // 新任务先清成草稿：真正建会话推迟到首次发送，才能把用户选的模型/助手写进会话。
    // 同时去掉 ?session=，避免刷新后又跳回刚离开的会话。
    window.history.replaceState(null, '', '/');
    setSessionId('');
    resetConversation();
    void refreshModels();
    void refreshAssistants();
    composerRef.current?.focus();
  }

  /** 改名/置顶由后端校验并返回新摘要，这里就地更新后按同一规则重排。 */
  async function handleUpdateSession(id: string, patch: UpdateSessionRequest): Promise<void> {
    const updated = await updateSession(id, patch);
    setSessions((prev) => sortSessions(prev.map((s) => (s.id === id ? updated : s))));
  }

  async function handleDeleteSession(id: string): Promise<void> {
    await deleteSession(id);
    releaseEntry(id);
    const remaining = sessionsRef.current.filter((s) => s.id !== id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (id !== sessionId) return;
    // 删掉的是当前会话：优先落到列表第一条，否则回到空白草稿。
    const next = remaining[0];
    if (next) {
      handleSelect(next.id);
      return;
    }
    window.history.replaceState(null, '', '/');
    setSessionId('');
    resetConversation();
  }

  /** 自动命名在后台进行：终态后补拉一次，仍在生成时稍后重试；失败不影响使用。 */
  async function syncSessionTitle(sid: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
      try {
        const summary = await getSession(sid);
        setSessions((prev) =>
          prev.some((s) => s.id === sid)
            ? sortSessions(prev.map((s) => (s.id === sid ? summary : s)))
            : prev,
        );
        if (summary.title !== '新会话') return;
      } catch {
        // 标题只是锦上添花，拉取失败保持原样。
        return;
      }
    }
  }

  function handleAssistantChange(id: string) {
    setSelectedAssistantId(id);
    const assistant = assistants.find((a) => a.id === id);
    // 助手指定的默认模型在可用目录内时跟随切换；不可用时保留用户当前选择，
    // 服务端建会话时以显式模型为准，不会因助手配置失效而卡死。
    if (assistant?.model && models.some((m) => m.model === assistant.model)) {
      setSelectedModel(assistant.model);
    }
  }

  /** 客户端预检后立即展示 chip，并并发上传；单个失败只影响该附件。 */
  function addFiles(files: File[]): void {
    if (running || files.length === 0) return;
    const { accepted, rejected } = checkFiles(files, pendingRef.current.length);
    if (rejected.length > 0) setError(rejected.map(fileRejectText).join('；'));
    if (accepted.length === 0) return;

    const queued = accepted.map(({ file, kind }) => {
      const previewUrl = kind === 'image' ? URL.createObjectURL(file) : undefined;
      if (previewUrl) trackUrl(previewUrl);
      const item: PendingAttachment = {
        localId: crypto.randomUUID(),
        filename: file.name,
        kind,
        size: file.size,
        status: 'uploading',
        previewUrl,
      };
      return { file, item };
    });
    pendingRef.current = [...pendingRef.current, ...queued.map((q) => q.item)];
    setPendingAttachments(pendingRef.current);
    for (const { file, item } of queued) void uploadOne(file, item.localId);
  }
  addFilesRef.current = addFiles;

  async function uploadOne(file: File, localId: string): Promise<void> {
    try {
      const dto = await uploadAttachment(file);
      // 上传期间用户可能已移除该 chip：此时把刚写入的对象立即删掉，避免孤儿附件。
      if (!pendingRef.current.some((p) => p.localId === localId)) {
        void deleteAttachment(dto.id).catch(() => undefined);
        return;
      }
      pendingRef.current = pendingRef.current.map((p) =>
        p.localId === localId ? { ...p, status: 'ready' as const, dto } : p,
      );
      setPendingAttachments(pendingRef.current);
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      pendingRef.current = pendingRef.current.map((p) =>
        p.localId === localId
          ? { ...p, status: 'error' as const, error: errorText(err) }
          : p,
      );
      setPendingAttachments(pendingRef.current);
    }
  }

  function removePending(localId: string): void {
    if (running) return;
    const target = pendingRef.current.find((p) => p.localId === localId);
    pendingRef.current = pendingRef.current.filter((p) => p.localId !== localId);
    setPendingAttachments(pendingRef.current);
    if (target?.previewUrl) releaseUrl(target.previewUrl);
    // 已上传的立即回收；上传中的会在 uploadOne 完成后自行清理。
    if (target?.dto) void deleteAttachment(target.dto.id).catch(() => undefined);
  }

  /**
   * 流事件统一走 tracker：初连、重连、挂回共用同一套处理，页面只有一份折叠逻辑。
   */
  function makeHandlers(id: string, st: RunStreamState): RunStreamHandlers {
    return {
      onStep(ev) {
        tracker.applyStep(id, ev);
        // 产物区是页面级的：只为当前查看的会话乐观上屏，后台会话等切回后由快照/刷新补。
        if (ev.type === 'artifact' && id === sessionIdRef.current) addOptimisticArtifact(ev);
        syncRunMarker(id);
      },
      onStatus(status, position) {
        // status 帧先写入 st.runId，再交给 tracker：排队期也有 runId 可停止、可标记。
        tracker.applyStatus(id, status, position, st.runId);
        syncRunMarker(id);
      },
      onDone(status) {
        tracker.applyDone(id, status);
      },
      onError(message) {
        // 错误提示是页面级的：后台会话的失败不弹到当前会话，条目自身已记为失败。
        if (id === sessionIdRef.current) setError(message);
        tracker.applyError(id);
      },
      onTerminal() {
        tracker.applyTerminal(id);
        syncRunMarker(id);
        // 自动命名按会话 id 更新侧栏，后台会话结束也要补。
        void syncSessionTitle(id);
        // 后台会话的终态由落库历史接管：条目与预览对象立即释放，避免长期占用内存。
        if (id !== sessionIdRef.current) {
          releaseEntry(id);
          return;
        }
        // 产物与界面是页面级的：只为当前查看的会话刷新，避免后台会话把别人的成果区覆盖掉。
        void refreshArtifacts(id);
        // 完成的那一轮已落库，交给历史接管；取消/失败保留实时条目，才能看到「已取消」与错误步骤。
        if (tracker.snapshot(id)?.finalStatus === 'done') void settleIntoTimeline(id);
      },
    };
  }

  /** 本地起跑/终态时同步侧栏标记；刷新列表后以后端返回值为准。 */
  function syncRunMarker(id: string) {
    const entry = tracker.snapshot(id);
    const active =
      entry && !entry.terminal && entry.runId
        ? {
            id: entry.runId,
            status: entry.status === 'queued' ? ('queued' as const) : ('running' as const),
          }
        : null;
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, activeRun: active } : s)));
  }

  /** 产物事件先乐观上屏，终态后由 refreshArtifacts 用落库版本覆盖。 */
  function addOptimisticArtifact(ev: AgentEvent) {
    setArtifacts((prev) => [
      {
        id: '',
        kind: String(ev.payload.kind ?? 'docx') as ArtifactDto['kind'],
        filename: String(ev.payload.filename ?? ''),
        size: Number(ev.payload.size ?? 0),
        version: 0,
        createdAt: new Date().toISOString(),
      },
      ...prev,
    ]);
  }

  async function run() {
    const currentGoal = goal;
    const ready = pendingRef.current.filter(
      (a): a is PendingAttachment & { dto: AttachmentDto } => a.status === 'ready' && !!a.dto,
    );
    const attachmentIds = ready.map((a) => a.dto.id);
    const submitted: RunAttachment[] = ready.map((a) => ({
      id: a.dto.id,
      kind: a.kind,
      filename: a.filename,
      mime: a.dto.mime,
      size: a.size,
      ...(a.previewUrl ? { previewUrl: a.previewUrl } : {}),
    }));
    stickToBottomRef.current = true;
    artifactReqRef.current += 1;
    setGoal('');
    setError('');
    composerRef.current?.focus();
    let sid = sessionId;
    // 只有本次真正占位成功才在 finally 释放：提前 return 不能把别人的在途流标记删掉。
    let claimed = false;
    try {
      // 草稿态首次发送才建会话，并把选中的模型固化到会话上。
      if (!sid) {
        const created = await createSession(
          selectedModel || undefined,
          selectedAssistantId || undefined,
          selectedMode,
        );
        setSessions((prev) => [created, ...prev]);
        if (created.model) setSelectedModel(created.model);
        setSelectedMode(created.mode);
        setSessionId(created.id);
        sid = created.id;
      }
      if (streamingRef.current.has(sid)) return;
      streamingRef.current.add(sid);
      claimed = true;
      // 会话创建成功后再清空输入区：失败时可保留附件重试。
      // 已发送附件的预览 URL 转交给 tracker 条目，切换/清理时统一释放。
      const sentIds = new Set(ready.map((a) => a.localId));
      for (const p of pendingRef.current) {
        if (!sentIds.has(p.localId) && p.previewUrl) releaseUrl(p.previewUrl);
      }
      pendingRef.current = [];
      setPendingAttachments([]);
      // 覆盖上一轮终态条目：先释放它的预览 URL，避免 object URL 泄漏。
      if (tracker.snapshot(sid)?.terminal) releaseEntry(sid);
      // 新建的 run 在库里就是 queued，先按排队展示，等状态帧或首个步骤再切执行中。
      const st = tracker.begin(sid, currentGoal, submitted);
      syncRunMarker(sid);
      const res = await streamTask(sid, currentGoal, attachmentIds);
      if (!res.ok) {
        // 错误响应通常带 JSON body 但没有 SSE 帧；不在此拦截就会静默结束、既不报错也无事件。
        const detail = await res.text().catch(() => '');
        throw new Error(`stream_failed_${res.status}${detail ? `: ${detail}` : ''}`);
      }
      // 流在读取阶段也可能抛错（网络中断）：先记录，再用游标重连一次补回断档。
      let streamError: unknown = null;
      try {
        await consumeRunStream(res, st, makeHandlers(sid, st));
      } catch (err) {
        streamError = err;
      }
      if (!st.terminal && st.runId) {
        // 取消也一样重连，终态帧丢失时由这次重连回放 status(canceled)+done 收尾。
        const retry = await streamRun(st.runId, st.lastSeq);
        if (!retry.ok) throw new Error(`stream_failed_${retry.status}`);
        if (sid === sessionIdRef.current) setError('');
        await consumeRunStream(retry, st, makeHandlers(sid, st));
      }
      // 重连已经拿到终态就不算失败；否则把最初的读取错误交给外层 catch。
      if (streamError && !st.terminal) throw streamError;
      if (!st.terminal) {
        tracker.settle(sid, 'failed');
        syncRunMarker(sid);
        void syncSessionTitle(sid);
        if (sid === sessionIdRef.current) setError('连接已断开，可刷新恢复');
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      if (sid === sessionIdRef.current) setError(errorText(err));
      if (sid) {
        // 起跑失败也要收尾，否则该会话输入框会一直只读。
        tracker.settle(sid, 'failed');
        syncRunMarker(sid);
        void syncSessionTitle(sid);
      }
    } finally {
      if (claimed) {
        // 任何未收尾的退出（如 401 跳转前）都本地收尾，避免条目永远只读。
        if (!tracker.snapshot(sid)?.terminal) {
          tracker.settle(sid, 'failed');
          syncRunMarker(sid);
        }
        streamingRef.current.delete(sid);
      }
    }
  }

  /**
   * 按 runId 从头回放并接续。页面刷新、切到由其他标签页发起的运行、
   * 断线后重新选中会话都走这一条路径。
   */
  async function attachRun(id: string, runIdToAttach: string) {
    // 已有在途条目（运行中或正在写流）就不要再挂一条；终态条目可以换成后端报的新 run。
    const existing = tracker.snapshot(id);
    if (streamingRef.current.has(id) || (existing && !existing.terminal)) return;
    streamingRef.current.add(id);
    const st = tracker.attach(id, runIdToAttach, -1);
    try {
      const res = await streamRun(runIdToAttach, -1);
      if (!res.ok) throw new Error(`stream_failed_${res.status}`);
      await consumeRunStream(res, st, makeHandlers(id, st));
      if (!st.terminal) {
        // relay 对终态 run 会回放终态帧；没有终态说明连上了但流提前结束。
        tracker.settle(id, 'failed');
        syncRunMarker(id);
      }
    } catch (err) {
      // 先收尾再跳转：导航被取消时也不能留下永久只读的在途条目。
      tracker.settle(id, 'failed');
      syncRunMarker(id);
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      // 后台会话的失败不弹到当前会话的错误横幅。
      if (id === sessionIdRef.current) setError('连接已断开，可刷新恢复');
    } finally {
      streamingRef.current.delete(id);
    }
  }

  /** 本地没有在途流、但后端说该会话还在跑：按 activeRun 挂回。 */
  async function ensureAttached(id: string) {
    const existing = tracker.snapshot(id);
    if (streamingRef.current.has(id) || (existing && !existing.terminal)) return;
    const active = sessionsRef.current.find((s) => s.id === id)?.activeRun;
    if (active) await attachRun(id, active.id);
  }

  async function stopRun() {
    if (!runId || stopping || !sessionId) return;
    tracker.markStopping(sessionId);
    try {
      // 不本地结束运行：等取消的终态事件到达，由事件流统一收尾。
      const result = await cancelRun(runId);
      // 取消已受理但终态帧可能还在路上：保持 stopping，由 onTerminal 收尾。
      if (result.status === 'done' || result.status === 'failed' || result.status === 'canceled') {
        tracker.applyStatus(sessionId, result.status, null);
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        tracker.clearStopping(sessionId);
        return;
      }
      // 取消失败时运行可能仍在继续：恢复按钮，并提示可重试。
      tracker.clearStopping(sessionId);
      setError(errorText(err));
    }
  }

  async function decide(confirmId: string, approved: boolean) {
    if (!runId || !sessionId) return;
    // 立即禁用按钮（在 tool_result 回来之前给出反馈）；随后由事件流自然收尾。
    tracker.decide(sessionId, confirmId, approved);
    try {
      await confirmRun(runId, confirmId, approved);
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      // 决策未送达（网络/上游故障）：撤销乐观禁用，否则按钮会一直卡到闸门超时。
      tracker.undecide(sessionId, confirmId);
      setError(errorText(err));
    }
  }

  const current = sessions.find((s) => s.id === sessionId);
  // 首页可能停在自动选中的已有会话上，推荐内容跟随会话固化的任务类型。
  const heroMode = sessionId ? (current?.mode ?? selectedMode) : selectedMode;
  const heroCategories = MODE_SUGGESTION_CATEGORIES[heroMode] ?? [];
  const heroCategory = heroCategories.find((c) => c.key === categoryKey) ?? heroCategories[0];
  // 历史会话没有固化模型时展示运营端默认值（与服务端 resolveForRun 的缺省一致）。
  const modelValue = sessionId ? (current?.model || defaultModel || selectedModel) : selectedModel;
  const modelAvailable =
    !sessionId || models.length === 0 || models.some((m) => m.model === modelValue);
  const selectedModelInfo = models.find((m) => m.model === modelValue);
  const readyAttachments = pendingAttachments.filter((a) => a.status === 'ready');
  const uploadingAttachments = pendingAttachments.some((a) => a.status === 'uploading');
  const failedAttachments = pendingAttachments.filter((a) => a.status === 'error');
  const blockedKinds = unsupportedModalities(
    pendingAttachments.filter((a) => a.status !== 'error').map((a) => a.kind),
    selectedModelInfo?.modalities,
  );
  const canSend =
    !running &&
    (!!goal.trim() || readyAttachments.length > 0) &&
    !uploadingAttachments &&
    // 上传失败的附件不能静默丢弃：用户以为附上了却实际没发，必须显式移除后再发送。
    failedAttachments.length === 0 &&
    blockedKinds.length === 0 &&
    models.length > 0 &&
    modelAvailable;
  const inConversation =
    running ||
    history.length > 0 ||
    events.length > 0 ||
    submittedGoal !== '' ||
    submittedAttachments.length > 0;
  const confirmCard = currentConfirmCard(events);

  // 左侧问题导航：只收有正文的用户消息（附件-only 的消息不值得作为定位点）。
  const userAnchors = [
    ...history
      .filter((m) => m.role === 'user' && m.content.trim() !== '')
      .map((m) => ({ id: m.id, text: m.content })),
    ...(showPendingTurn && submittedGoal.trim() !== ''
      ? [{ id: 'pending', text: submittedGoal }]
      : []),
  ];

  /** 导轨上只放首行摘要，完整问题由 title/aria-label 承载。 */
  function anchorLabel(text: string): string {
    const line = text.trim().split(/\r?\n/, 1)[0] ?? '';
    return line.length > 42 ? `${line.slice(0, 42)}…` : line;
  }

  /** 高亮与视口顶部最近（已划过）的那个问题；导轨点击后也用它即时反馈。 */
  function syncActiveAnchor() {
    const root = scrollRef.current;
    if (!root) return;
    const items = root.querySelectorAll<HTMLElement>('[data-user-anchor]');
    if (items.length === 0) {
      setActiveAnchor('');
      return;
    }
    // 贴底时高亮最后一个问题：用户正看着最新一轮问答。
    if (root.scrollHeight - root.scrollTop - root.clientHeight < 40) {
      setActiveAnchor(items[items.length - 1]!.dataset.userAnchor ?? '');
      return;
    }
    const threshold = root.getBoundingClientRect().top + 24;
    let current = items[0]!.dataset.userAnchor ?? '';
    for (const item of items) {
      if (item.getBoundingClientRect().top <= threshold) current = item.dataset.userAnchor ?? '';
    }
    setActiveAnchor(current);
  }

  function jumpToAnchor(id: string) {
    const root = scrollRef.current;
    if (!root) return;
    const target = Array.from(root.querySelectorAll<HTMLElement>('[data-user-anchor]')).find(
      (el) => el.dataset.userAnchor === id,
    );
    if (!target) return;
    // 跳转后关闭“跟随底部”，否则下一条流式增量会把视图又拽回末尾。
    stickToBottomRef.current = false;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveAnchor(id);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    // 历史加载、新问题出现或增量增长时都重新判定高亮项。
    syncActiveAnchor();
  }, [history.length, events.length, running, confirmCard?.confirmId, submittedGoal, liveText]);

  useEffect(() => {
    // 发送后视图从 Hero 切到会话，输入器会重新挂载，run() 里的同步 focus 会随旧节点卸载丢失。
    // 放到提交后的 effect 中重新聚焦，确保 readOnly 期间焦点仍在输入器。
    if (!running) return;
    composerRef.current?.focus({ preventScroll: true });
  }, [running]);

  const composer = (
    <div
      className={`wb-composer-wrap${dragOver ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (running) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget;
        if (next instanceof Node && e.currentTarget.contains(next)) return;
        setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (!running) addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        hidden
        multiple
        accept={ATTACHMENT_ACCEPT}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // 先清空 value，同一个文件再次选择时仍会触发 change。
          e.target.value = '';
          addFiles(files);
        }}
      />
      {!sessionId && (
        <Tabs
          className="wb-mode-tabs"
          size="small"
          centered
          activeKey={selectedMode}
          onChange={(key) => setSelectedMode(key as SessionMode)}
          items={SESSION_MODES.map((mode) => ({
            key: mode,
            label: SESSION_MODE_LABELS[mode],
            disabled: running,
          }))}
        />
      )}
      {!sessionId && heroCategory && (
        <div className="wb-sugg-cats" role="tablist" aria-label="常见问题分类">
          {heroCategories.map((c) => (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={c.key === heroCategory.key}
              className="wb-sugg-cat"
              onClick={() => setCategoryKey(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      <div className="wb-composer">
        {!sessionId && assistants.length > 0 && (
          <div className="wb-composer-model">
            <select
              className="wb-model-select"
              value={selectedAssistantId}
              onChange={(e) => handleAssistantChange(e.target.value)}
              disabled={running}
              aria-label="选择助手"
              title="选择本次任务使用的助手"
            >
              <option value="">默认助手</option>
              {assistants.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {modelsLoaded && models.length === 0 && (
          <div className="wb-model-empty">当前套餐暂无可用模型，请联系管理员。</div>
        )}
        {!modelAvailable && (
          <div className="wb-model-empty">该会话使用的模型已停用，请新建任务。</div>
        )}
        {pendingAttachments.length > 0 && (
          <div className="wb-attachments" aria-label="待发送附件">
            {pendingAttachments.map((a) => (
              <div
                key={a.localId}
                className={`wb-attachment${a.status === 'error' ? ' is-error' : ''}`}
                title={a.error ?? a.filename}
              >
                {a.previewUrl ? (
                  // 本地 object URL 预览，不上传两次；发送后由会话内附件状态接管。
                  <img className="wb-attachment-thumb" src={a.previewUrl} alt="" />
                ) : (
                  <span className="wb-attachment-icon" aria-hidden="true">
                    <IconFile size={14} />
                  </span>
                )}
                <span className="wb-attachment-body">
                  <span className="wb-attachment-name">{a.filename}</span>
                  <span className="wb-attachment-meta">
                    {attachmentKindLabel(a.kind)} · {formatBytes(a.size)}
                    {a.status === 'uploading' ? ' · 上传中…' : ''}
                    {a.status === 'error' ? ' · 上传失败' : ''}
                  </span>
                </span>
                <button
                  type="button"
                  className="wb-attachment-remove"
                  onClick={() => removePending(a.localId)}
                  disabled={running}
                  aria-label={`移除 ${a.filename}`}
                  title="移除"
                >
                  <IconX size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {blockedKinds.length > 0 && (
          <div className="wb-model-empty wb-attachment-warning" role="alert">
            {modalityWarning(blockedKinds)}
          </div>
        )}
        {failedAttachments.length > 0 && (
          <div className="wb-model-empty wb-attachment-warning" role="alert">
            有 {failedAttachments.length} 个附件上传失败，请移除或重新添加后再发送。
          </div>
        )}
        <textarea
          ref={composerRef}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) void run();
            }
          }}
          placeholder="今天帮你做些什么？写下目标，智能体会规划并执行；可拖入或粘贴文件…"
          rows={2}
          readOnly={running}
          aria-label="任务目标"
        />
        <div className="wb-composer-foot">
          <button
            type="button"
            className="wb-attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={running || pendingAttachments.length >= ATTACHMENT_MAX_PER_MESSAGE}
            aria-label="添加附件"
            title="添加附件（文本、图片、音频、视频，支持直接粘贴）"
          >
            <IconPlus size={16} />
          </button>
          <span className="wb-composer-hint">Enter 发送 · Shift + Enter 换行</span>
          <div className="spacer" />
          <select
            className="wb-model-select"
            value={modelValue}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={running || !!sessionId || models.length === 0}
            aria-label="选择模型"
            title={sessionId ? '切换模型请新建任务' : '选择本次任务使用的模型'}
          >
            {!modelAvailable && modelValue && (
              <option value={modelValue}>{modelValue}（已停用）</option>
            )}
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.displayName && m.displayName !== m.model
                  ? `${m.displayName} · ${m.model} · ${m.providerName}`
                  : `${m.model} · ${m.providerName}`}
              </option>
            ))}
          </select>
          {running && runId && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void stopRun()}
              disabled={stopping}
              aria-label={stopping ? '正在停止' : '停止执行'}
              title={stopping ? '正在停止' : '停止执行'}
            >
              {stopping ? '正在停止…' : '停止'}
            </button>
          )}
          <button
            type="button"
            className="wb-send"
            onClick={() => void run()}
            disabled={!canSend}
            aria-label="开始执行"
            title="开始执行"
          >
            <IconSend size={17} />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <AppShell
      active="workbench"
      sessions={sessions}
      sessionsHasMore={sessionsCursor !== null}
      sessionsLoadingMore={sessionsLoadingMore}
      onLoadMoreSessions={() => void loadMoreSessions()}
      sessionId={sessionId}
      onSelectSession={handleSelect}
      onNewSession={() => void handleNewSession()}
      onUpdateSession={handleUpdateSession}
      onDeleteSession={handleDeleteSession}
    >
      <div className="wb-topbar">
        <span className="wb-topbar-title">
          {current?.title ?? '新任务'}
          {current?.assistantName && (
            <span className="wb-assistant-badge">助手：{current.assistantName}</span>
          )}
        </span>
        <div className="wb-topbar-actions">
          <button
            type="button"
            className={`wb-icon-btn wb-drawer-trigger${drawerOpen ? ' active' : ''}`}
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label={artifacts.length ? `成果（${artifacts.length} 个文件）` : '成果'}
            aria-expanded={drawerOpen}
            aria-controls="wb-artifacts-panel"
            title="成果"
          >
            <IconFile size={17} />
            {artifacts.length > 0 && (
              <span className="wb-badge" aria-hidden="true">
                {artifacts.length}
              </span>
            )}
          </button>
        </div>
      </div>

      <div className="wb-sr-only" role="status" aria-live="polite">
        {/* 唯一的读屏播报区：可见状态块只是视觉反馈，不再各自注册 live region，避免重复朗读。 */}
        {running
          ? runStatus === 'queued'
            ? `排队中…${queuePosition !== null && queuePosition > 0 ? `（前方 ${queuePosition} 个任务）` : ''}`
            : '智能体执行中…'
          : runStatus === 'canceled'
            ? '已取消'
            : submittedGoal && events.length > 0
              ? '执行已结束'
              : ''}
      </div>

      {error && (
        <div className="banner banner-error wb-banner" role="alert">
          {error}
        </div>
      )}

      <div className="wb-workbench">
        {inConversation ? (
          <div className="wb-conv">
            <div
              className="wb-conv-body"
              onWheel={(e) => {
                // 滚动区收窄到消息栏后，两侧留白里的滚轮事件转发给消息区，
                // 否则在宽屏空白处滚动没有反应。
                const root = scrollRef.current;
                if (!root || (e.target instanceof Node && root.contains(e.target))) return;
                markUserScroll();
                root.scrollTop += e.deltaY;
              }}
            >
              {userAnchors.length > 0 && (
                <nav className="wb-msg-nav" aria-label="问题快速定位">
                  {userAnchors.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      className={`wb-msg-nav-item${u.id === activeAnchor ? ' is-active' : ''}`}
                      onClick={() => jumpToAnchor(u.id)}
                      title={anchorLabel(u.text)}
                      aria-label={`定位到问题：${anchorLabel(u.text)}`}
                      aria-current={u.id === activeAnchor ? 'location' : undefined}
                    />
                  ))}
                </nav>
              )}
              <div
                ref={scrollRef}
                className="wb-conv-scroll"
                onScroll={(e) => {
                  syncActiveAnchor();
                  if (Date.now() - lastUserScrollRef.current > 400) return;
                  const el = e.currentTarget;
                  stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                }}
              onWheel={markUserScroll}
              onTouchMove={markUserScroll}
              onPointerDown={markUserScroll}
              onKeyDown={markUserScroll}
            >
              <div className="wb-thread">
                {history.length > 0 && (
                  <div className="wb-chat">
                    {history.map((m) =>
                      m.role === 'user' ? (
                        <div
                          className="wb-user-msg"
                          key={m.id}
                          data-user-anchor={m.content.trim() ? m.id : undefined}
                        >
                          {m.content && <div className="wb-user-text">{m.content}</div>}
                          {m.attachments.length > 0 && (
                            <div className="wb-user-attachments">
                              {m.attachments.map((a) => (
                                <span key={a.id} className="wb-user-attachment" title={a.filename}>
                                  <IconFile size={14} />
                                  <span className="wb-user-attachment-name">{a.filename}</span>
                                  <span className="wb-user-attachment-meta">
                                    {attachmentKindLabel(a.kind)}
                                  </span>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="wb-assistant-msg" key={m.id}>
                          <span className="wb-assistant-avatar" aria-hidden="true">
                            <IconSpark size={16} />
                          </span>
                          <div className="wb-assistant-text wb-assistant-md">
                            <Markdown>{m.content}</Markdown>
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                )}
                {showPendingTurn && (submittedGoal || submittedAttachments.length > 0) && (
                  <div
                    className="wb-user-msg"
                    data-user-anchor={submittedGoal.trim() ? 'pending' : undefined}
                  >
                    {submittedGoal && <div className="wb-user-text">{submittedGoal}</div>}
                    {submittedAttachments.length > 0 && (
                      <div className="wb-user-attachments">
                        {submittedAttachments.map((a) => (
                          <span key={a.id} className="wb-user-attachment" title={a.filename}>
                            {a.previewUrl ? (
                              <img className="wb-attachment-thumb" src={a.previewUrl} alt="" />
                            ) : (
                              <IconFile size={14} />
                            )}
                            <span className="wb-user-attachment-name">{a.filename}</span>
                            <span className="wb-user-attachment-meta">
                              {attachmentKindLabel(a.kind)}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {events.map((ev) =>
                  ev.type === 'think' ? (
                    <AssistantBubble key={ev.seq} text={String(ev.payload.text ?? '')} />
                  ) : (
                    <EventRow
                      key={ev.seq}
                      ev={ev}
                      expectedModel={modelValue}
                      onOpenArtifacts={() => setDrawerOpen(true)}
                    />
                  ),
                )}
                {liveText && <AssistantBubble text={liveText} live />}
                {running && (
                  <div className="wb-running">
                    <span className="wb-spinner" />
                    {runStatus === 'queued'
                      ? `排队中…${queuePosition !== null && queuePosition > 0 ? `（前方 ${queuePosition} 个任务）` : ''}`
                      : '智能体执行中…'}
                  </div>
                )}
                {!running && runStatus === 'canceled' && (
                  <div className="wb-running">已取消</div>
                )}
              </div>

              {confirmCard &&
                (() => {
                  const decided = decisions[confirmCard.confirmId];
                  return (
                    <div className="wb-confirm" role="alert">
                      <div className="wb-confirm-title">需要确认：{confirmCard.tool}</div>
                      <div className="wb-confirm-sub">该工具会访问外部资源，请确认后再执行。</div>
                      <pre className="wb-confirm-args">{JSON.stringify(confirmCard.args, null, 2)}</pre>
                      {decided === undefined ? (
                        <div className="wb-confirm-actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => void decide(confirmCard.confirmId, true)}
                          >
                            允许执行
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => void decide(confirmCard.confirmId, false)}
                          >
                            拒绝
                          </button>
                        </div>
                      ) : (
                        <span className="wb-confirm-done">
                          <IconCheck size={14} />
                          {decided ? '已允许' : '已拒绝'}（等待执行结果…）
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
            <div className="wb-composer-dock">
              {composer}
              <p className="wb-disclaimer">内容由 AI 生成，请核实重要信息。</p>
            </div>
          </div>
        ) : (
          <div className="wb-hero">
            <h1 className="wb-hero-title">
              AI 办公智能体，<em>我帮你</em>
            </h1>
            <p className="wb-hero-sub">{HERO_SUB[heroMode]}</p>
            {composer}
            {heroCategory ? (
              <div className="wb-suggestion-grid">
                {heroCategory.questions.map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    className="wb-suggestion"
                    title={q.goal}
                    onClick={() => setGoal(q.goal)}
                  >
                    <span>{q.label}</span>
                    <IconArrowUpRight size={15} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="wb-suggestions">
                {CHAT_SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className="wb-suggestion"
                    onClick={() => setGoal(s.goal)}
                  >
                    <span>{s.label}</span>
                    <IconArrowUpRight size={15} />
                  </button>
                ))}
              </div>
            )}
            <p className="wb-disclaimer">内容由 AI 生成，请核实重要信息。</p>
          </div>
        )}

        <ArtifactDrawer
          open={drawerOpen}
          artifacts={artifacts}
          onClose={() => setDrawerOpen(false)}
          onDownload={(a) =>
            void downloadArtifact(a.id, a.filename).catch((e) => setError(errorText(e)))
          }
        />
      </div>
    </AppShell>
  );
}
