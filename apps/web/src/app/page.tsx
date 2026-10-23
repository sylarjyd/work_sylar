'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentEvent, ArtifactDto, ClientModelDto, SessionSummary } from '@ai-office/shared';
import { AppShell } from '../components/app-shell';
import { ArtifactDrawer } from '../components/artifact-drawer';
import {
  IconArrowUpRight,
  IconCheck,
  IconCopy,
  IconFile,
  IconSend,
  IconSpark,
  IconTool,
  IconX,
} from '../components/icons';
import { errorText } from '@ai-office/web-core';
import { createSseParser } from '../lib/sse-parser';
import {
  confirmRun,
  createSession,
  downloadArtifact,
  getToken,
  isUnauthorized,
  listArtifacts,
  listModels,
  listSessions,
  streamTask,
} from '../lib/api';
import { currentConfirmCard } from '../lib/pending-confirm';
import { renderStep } from '../lib/render-step';

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
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [models, setModels] = useState<ClientModelDto[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  // 运营端默认模型：历史会话（model 为空）首次运行前展示的就是它。
  const [defaultModel, setDefaultModel] = useState('');
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const artifactReqRef = useRef(0);
  const lastUserScrollRef = useRef(0);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    void refresh();
    void refreshModels();
  }, [router]);

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

  function resetConversation() {
    setEvents([]);
    setSubmittedGoal('');
    setDecisions({});
    setError('');
    stickToBottomRef.current = true;
    artifactReqRef.current += 1;
    setArtifacts([]);
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
    // 新任务先清成草稿：真正建会话推迟到首次发送，才能把用户选的模型写进会话。
    setSessionId('');
    resetConversation();
    void refreshModels();
    composerRef.current?.focus();
  }

  async function run() {
    const currentGoal = goal;
    stickToBottomRef.current = true;
    artifactReqRef.current += 1;
    setEvents([]);
    setSubmittedGoal(currentGoal);
    setGoal('');
    setRunning(true);
    setError('');
    setDecisions({});
    composerRef.current?.focus();
    let sid = sessionId;
    try {
      // 草稿态首次发送才建会话，并把选中的模型固化到会话上。
      // 不能用 setSessionId 后的 state：本次渲染闭包拿不到新值。
      if (!sid) {
        const created = await createSession(selectedModel || undefined);
        setSessions((prev) => [created, ...prev]);
        if (created.model) setSelectedModel(created.model);
        setSessionId(created.id);
        sid = created.id;
      }
      const res = await streamTask(sid, currentGoal);
      if (!res.ok) {
        // 错误响应通常带 JSON body 但没有 SSE 帧；不在此拦截就会静默结束、既不报错也无事件。
        const detail = await res.text().catch(() => '');
        throw new Error(`stream_failed_${res.status}${detail ? `: ${detail}` : ''}`);
      }
      if (!res.body) throw new Error('no body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parse = createSseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const m of parse(decoder.decode(value, { stream: true }))) {
          if (m.event === 'step') {
            const ev = m.data as AgentEvent;
            setRunId(ev.runId);
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
          }
          if (m.event === 'error') {
            const d = m.data as { message?: unknown } | null;
            setError(d && typeof d.message === 'string' ? d.message : JSON.stringify(m.data));
          }
        }
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    } finally {
      setRunning(false);
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
  const canSend = !running && !!goal.trim() && models.length > 0 && modelAvailable;
  const inConversation = running || events.length > 0 || submittedGoal !== '';
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
    <div className="wb-composer-wrap">
      <div className="wb-composer">
        <div className="wb-composer-model">
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
          {sessionId && <span className="wb-model-lock">切换模型请新建任务</span>}
        </div>
        {modelsLoaded && models.length === 0 && (
          <div className="wb-model-empty">当前套餐暂无可用模型，请联系管理员。</div>
        )}
        {!modelAvailable && (
          <div className="wb-model-empty">该会话使用的模型已停用，请新建任务。</div>
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
          placeholder="今天帮你做些什么？写下目标，智能体会规划并执行…"
          rows={2}
          readOnly={running}
          aria-label="任务目标"
        />
        <div className="wb-composer-foot">
          <span className="wb-composer-hint">Enter 发送 · Shift + Enter 换行</span>
          <div className="spacer" />
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
        <span className="wb-topbar-title">{current?.title ?? '新任务'}</span>
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
        {running ? '智能体执行中' : submittedGoal && events.length > 0 ? '执行已结束' : ''}
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
                {submittedGoal && (
                  <div className="wb-user-msg">
                    <div className="wb-user-text">{submittedGoal}</div>
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
                    智能体执行中…
                  </div>
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
