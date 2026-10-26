'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_PER_MESSAGE,
  MODEL_MODALITY_LABELS,
  attachmentKindLabel,
  type AgentEvent,
  type ArtifactDto,
  type AssistantDto,
  type AttachmentDto,
  type AttachmentKind,
  type AttachmentRef,
  type ClientModelDto,
  type RunStatus,
  type SessionSummary,
} from '@ai-office/shared';
import { AppShell } from '../components/app-shell';
import { ArtifactDrawer } from '../components/artifact-drawer';
import {
  IconArrowUpRight,
  IconCheck,
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
  createRunStreamState,
  type RunStreamHandlers,
} from '../lib/run-stream';
import {
  cancelRun,
  confirmRun,
  createSession,
  deleteAttachment,
  downloadArtifact,
  getToken,
  isUnauthorized,
  listArtifacts,
  listAssistants,
  listModels,
  listSessions,
  streamRun,
  streamTask,
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

/** 已提交消息的附件；previewUrl 仅供本次会话内即时预览，刷新后不再保留。 */
interface SubmittedAttachment extends AttachmentRef {
  previewUrl?: string;
}

const SUGGESTIONS = [
  { label: '写一份周报', goal: '整理本周工作进展，生成一份周报文档' },
  { label: '调研竞品', goal: '调研竞品并给出结论' },
  { label: '做一张数据表', goal: '把项目数据整理成表格，包含汇总与趋势' },
  { label: '生成演示稿', goal: '根据项目方案生成一份演示稿' },
];

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
  const copyTimer = useRef<number | undefined>(undefined);
  const text = renderStep(ev);

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
        <div className="wb-event-text">{text}</div>
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

export default function Home() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>('');
  const [goal, setGoal] = useState('');
  const [submittedGoal, setSubmittedGoal] = useState('');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactDto[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [runId, setRunId] = useState('');
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [models, setModels] = useState<ClientModelDto[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  // 运营端默认模型：历史会话（model 为空）首次运行前展示的就是它。
  const [defaultModel, setDefaultModel] = useState('');
  const [modelsLoaded, setModelsLoaded] = useState(false);
  // 自定义助手：仅新建任务（草稿态）可选择，会话创建后助手固定。
  const [assistants, setAssistants] = useState<AssistantDto[]>([]);
  const [selectedAssistantId, setSelectedAssistantId] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [submittedAttachments, setSubmittedAttachments] = useState<SubmittedAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<PendingAttachment[]>([]);
  const addFilesRef = useRef<(files: File[]) => void>(() => undefined);
  // 所有由本页创建的 object URL 统一登记，卸载时兜底释放，避免长期占用 blob 内存。
  const objectUrlsRef = useRef(new Set<string>());
  const artifactReqRef = useRef(0);
  const lastUserScrollRef = useRef(0);
  // 重连游标：seq 从 0 开始，未收到任何 step 时用 -1 从头回放。
  const lastSeqRef = useRef(-1);
  pendingRef.current = pendingAttachments;

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    void refresh();
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

  async function refresh() {
    try {
      const list = await listSessions();
      setSessions(list);
      if (list.length) {
        setSessionId(list[0].id);
        if (list[0].model) setSelectedModel(list[0].model);
      }
    } catch (err) {
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

  function discardSubmitted(): void {
    setSubmittedAttachments((prev) => {
      for (const a of prev) if (a.previewUrl) releaseUrl(a.previewUrl);
      return [];
    });
  }

  function resetConversation() {
    setEvents([]);
    setSubmittedGoal('');
    setDecisions({});
    setError('');
    setRunStatus(null);
    setQueuePosition(null);
    stickToBottomRef.current = true;
    artifactReqRef.current += 1;
    setArtifacts([]);
    discardPending();
    discardSubmitted();
  }

  function handleSelect(id: string) {
    if (running || id === sessionId) return;
    const target = sessions.find((s) => s.id === id);
    // 历史会话没有固化的模型：展示当前默认模型，实际运行由服务端按默认值解析。
    setSelectedModel(target?.model ?? defaultModel);
    setSessionId(id);
    resetConversation();
  }

  function markUserScroll() {
    lastUserScrollRef.current = Date.now();
  }

  function handleNewSession() {
    if (running) return;
    // 新任务先清成草稿：真正建会话推迟到首次发送，才能把用户选的模型/助手写进会话。
    setSessionId('');
    resetConversation();
    void refreshModels();
    void refreshAssistants();
    composerRef.current?.focus();
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

  async function run() {
    const currentGoal = goal;
    const ready = pendingRef.current.filter(
      (a): a is PendingAttachment & { dto: AttachmentDto } => a.status === 'ready' && !!a.dto,
    );
    const attachmentIds = ready.map((a) => a.dto.id);
    const submitted: SubmittedAttachment[] = ready.map((a) => ({
      id: a.dto.id,
      kind: a.kind,
      filename: a.filename,
      mime: a.dto.mime,
      size: a.size,
      ...(a.previewUrl ? { previewUrl: a.previewUrl } : {}),
    }));
    stickToBottomRef.current = true;
    artifactReqRef.current += 1;
    setEvents([]);
    setSubmittedGoal(currentGoal);
    setSubmittedAttachments(submitted);
    setGoal('');
    setRunning(true);
    setError('');
    setDecisions({});
    // 新一轮开始：清掉上一轮的运行态与游标，避免停止/重连误挂到旧运行。
    setRunId('');
    setRunStatus(null);
    setQueuePosition(null);
    setStopping(false);
    lastSeqRef.current = -1;
    const st = createRunStreamState();
    // 事件流只负责推进状态机，React 副作用集中在这里，初连与重连行为一致。
    const handlers: RunStreamHandlers = {
      onStep(ev) {
        lastSeqRef.current = st.lastSeq;
        if (typeof ev.runId === 'string' && ev.runId) setRunId(ev.runId);
        // 收到步骤说明已经开始执行，清掉排队提示。
        setRunStatus((prev) => (prev === 'queued' ? 'running' : prev));
        setQueuePosition(null);
        setEvents((prev) => [...prev, ev]);
        if (ev.type === 'artifact') {
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
      },
      onStatus(status, position) {
        if (st.runId) setRunId(st.runId);
        setRunStatus(status);
        setQueuePosition(position);
      },
      onDone(status) {
        setRunStatus(status);
      },
      onError(message) {
        setError(message);
        setRunStatus((prev) => (prev === 'canceled' ? prev : 'failed'));
        setQueuePosition(null);
      },
      onTerminal() {
        // 终态到达即结束「正在停止…」，不必等 run() 的 finally（重连期间保持禁用）。
        setStopping(false);
      },
    };
    composerRef.current?.focus();
    let sid = sessionId;
    try {
      // 草稿态首次发送才建会话，并把选中的模型固化到会话上。
      // 不能用 setSessionId 后的 state：本次渲染闭包拿不到新值。
      if (!sid) {
        const created = await createSession(
          selectedModel || undefined,
          selectedAssistantId || undefined,
        );
        setSessions((prev) => [created, ...prev]);
        if (created.model) setSelectedModel(created.model);
        setSessionId(created.id);
        sid = created.id;
      }
      // 会话创建成功后再清空输入区：失败时可保留附件重试。
      // 已发送附件的预览 URL 转交给 submittedAttachments，待切换会话时统一释放。
      const sentIds = new Set(ready.map((a) => a.localId));
      for (const p of pendingRef.current) {
        if (!sentIds.has(p.localId) && p.previewUrl) releaseUrl(p.previewUrl);
      }
      pendingRef.current = [];
      setPendingAttachments([]);
      const res = await streamTask(sid, currentGoal, attachmentIds);
      if (!res.ok) {
        // 错误响应通常带 JSON body 但没有 SSE 帧；不在此拦截就会静默结束、既不报错也无事件。
        const detail = await res.text().catch(() => '');
        throw new Error(`stream_failed_${res.status}${detail ? `: ${detail}` : ''}`);
      }
      await consumeRunStream(res, st, handlers);
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    } finally {
      // 流在没有终态的情况下断开（网络抖动/中间层超时）：本次发送已有 runId 时重连一次，
      // 用 afterSeq 补回断档事件。历史会话不会走到这里（run() 只在发送时调用）。
      // 取消也一样重连：终态帧丢失时，由这唯一一次重连回放 status(canceled)+done 收尾。
      if (!st.terminal && st.runId) {
        try {
          const res = await streamRun(st.runId, lastSeqRef.current);
          if (!res.ok) throw new Error(`stream_failed_${res.status}`);
          // 重连成功：清掉刚才断线瞬间留下的临时错误，后续若再有 error 事件会重新写入。
          setError('');
          await consumeRunStream(res, st, handlers);
        } catch (err) {
          if (isUnauthorized(err)) {
            router.push('/login');
          } else {
            setError('连接已断开，可刷新恢复');
          }
        }
      }
      // 未收到终态时也要解除「正在停止…」，否则按钮会一直卡在禁用态。
      setRunning(false);
      setStopping(false);
    }
  }

  async function stopRun() {
    if (!runId || stopping) return;
    setStopping(true);
    try {
      // 不本地结束 running：等取消的终态事件到达，由事件流统一收尾。
      const result = await cancelRun(runId);
      // 取消已受理但终态帧可能还在路上：保持 stopping，由 onTerminal 或 run() 收尾恢复。
      if (result.status === 'done' || result.status === 'failed' || result.status === 'canceled') {
        setRunStatus(result.status);
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        setStopping(false);
        return;
      }
      // 取消失败时运行可能仍在继续：恢复按钮，并提示可重试。
      setStopping(false);
      setError(errorText(err));
    }
  }

  async function decide(confirmId: string, approved: boolean) {
    // 立即禁用按钮（在 tool_result 回来之前给出反馈）；随后由事件流自然收尾。
    setDecisions((prev) => ({ ...prev, [confirmId]: approved }));
    try {
      await confirmRun(runId, confirmId, approved);
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      // 决策未送达（网络/上游故障）：撤销乐观禁用，否则按钮会一直卡在
      // 「已允许/已拒绝」直到闸门超时，用户无法重试。
      setDecisions((prev) => {
        const next = { ...prev };
        delete next[confirmId];
        return next;
      });
      setError(errorText(err));
    }
  }

  const current = sessions.find((s) => s.id === sessionId);
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
    running || events.length > 0 || submittedGoal !== '' || submittedAttachments.length > 0;
  const confirmCard = currentConfirmCard(events);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [events.length, running, confirmCard?.confirmId, submittedGoal]);

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
      <div className="wb-composer">
        <div className="wb-composer-model">
          {!sessionId && assistants.length > 0 && (
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
          )}
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
            {models.map((m) => {
              const tags = m.modalities.map((x) => MODEL_MODALITY_LABELS[x]).join('、');
              return (
                <option key={m.model} value={m.model}>
                  {m.displayName && m.displayName !== m.model
                    ? `${m.displayName} · ${m.model} · ${m.providerName}`
                    : `${m.model} · ${m.providerName}`}
                  {tags ? `［${tags}］` : ''}
                </option>
              );
            })}
          </select>
          {sessionId && <span className="wb-model-lock">切换模型请新建任务</span>}
        </div>
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
      sessionId={sessionId}
      onSelectSession={handleSelect}
      onNewSession={() => void handleNewSession()}
      sessionDisabled={running}
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
            ? `排队中…${queuePosition !== null ? `（前方 ${queuePosition} 个任务）` : ''}`
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
              ref={scrollRef}
              className="wb-conv-scroll"
              onScroll={(e) => {
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
                {(submittedGoal || submittedAttachments.length > 0) && (
                  <div className="wb-user-msg">
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
                {events.map((ev) => (
                  <EventRow
                    key={ev.seq}
                    ev={ev}
                    expectedModel={modelValue}
                    onOpenArtifacts={() => setDrawerOpen(true)}
                  />
                ))}
                {running && (
                  <div className="wb-running">
                    <span className="wb-spinner" />
                    {runStatus === 'queued'
                      ? `排队中…${queuePosition !== null ? `（前方 ${queuePosition} 个任务）` : ''}`
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
            <p className="wb-hero-sub">把目标交给智能体：它会调研、写文档、做表格、生成演示稿。</p>
            {composer}
            <div className="wb-suggestions">
              {SUGGESTIONS.map((s) => (
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
