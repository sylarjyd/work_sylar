'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentEvent, ArtifactDto, SessionSummary } from '@ai-office/shared';
import { AppShell } from '../components/app-shell';
import {
  IconCheck,
  IconDownload,
  IconFile,
  IconSend,
  IconSpark,
  IconTool,
  IconX,
} from '../components/icons';
import { errorText } from '../lib/errors';
import { formatBytes } from '../lib/format';
import { createSseParser } from '../lib/sse-parser';
import {
  confirmRun,
  createSession,
  downloadArtifact,
  getToken,
  isUnauthorized,
  listArtifacts,
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

function EventRow({ ev }: { ev: AgentEvent }) {
  const text = renderStep(ev);
  if (!text) return null;

  let meta = '事件';
  let iconCls = 'tool';
  let icon = <IconTool size={15} />;

  if (ev.type === 'think') {
    meta = '思考';
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

  return (
    <div className="thread-item">
      <div className={`thread-icon ${iconCls}`}>{icon}</div>
      <div className="thread-body">
        <div className="thread-meta">{meta}</div>
        <div className="thread-text">{text}</div>
      </div>
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

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    void refresh();
  }, [router]);

  async function refresh() {
    try {
      const list = await listSessions();
      setSessions(list);
      if (list.length) setSessionId(list[0].id);
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    }
  }

  async function refreshArtifacts(sid: string) {
    if (!sid) {
      setArtifacts([]);
      return;
    }
    try {
      setArtifacts(await listArtifacts(sid));
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    }
  }

  useEffect(() => {
    // 跑流期间不刷新：新会话在建流时会 setSessionId 触发本 effect，若并发拉取会覆盖乐观卡片；
    // 流结束后由 run() 的 finally 统一刷新，故这里等待 running 归位。
    if (running) return;
    void refreshArtifacts(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, running]);

  async function newSession(): Promise<SessionSummary> {
    const s = await createSession();
    setSessions((prev) => [s, ...prev]);
    setSessionId(s.id);
    return s;
  }

  function resetConversation() {
    setEvents([]);
    setSubmittedGoal('');
    setDecisions({});
    setError('');
  }

  function handleSelect(id: string) {
    if (running || id === sessionId) return;
    setSessionId(id);
    resetConversation();
  }

  async function handleNewSession() {
    try {
      await newSession();
      resetConversation();
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    }
  }

  async function run() {
    setEvents([]);
    setSubmittedGoal(goal);
    setRunning(true);
    setError('');
    setDecisions({});
    let sid = sessionId;
    try {
      // sessionId 为 state，newSession 的 setSessionId 不会同步更新本次渲染闭包里的值，
      // 故必须用 newSession 返回的 id 直接发起请求，否则会 POST 到空 id 的会话。
      if (!sid) sid = (await newSession()).id;
      const res = await streamTask(sid, goal);
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
      void refreshArtifacts(sid);
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
  const inConversation = running || events.length > 0 || submittedGoal !== '';
  const confirmCard = currentConfirmCard(events);

  const composer = (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!running && goal.trim()) void run();
            }
          }}
          placeholder="今天帮你做些什么？写下目标，智能体会规划并执行…"
          rows={2}
          disabled={running}
          aria-label="任务目标"
        />
        <div className="composer-foot">
          <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
          <div className="spacer" />
          <button
            type="button"
            className="send-btn"
            onClick={() => void run()}
            disabled={running || !goal.trim()}
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
      <div className="topbar">
        <span className="topbar-title">{current?.title ?? '新任务'}</span>
        <div className="topbar-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void handleNewSession()}
            disabled={running}
          >
            新会话
          </button>
        </div>
      </div>

      {error && (
        <div className="banner banner-error banner-inset" role="alert">
          {error}
        </div>
      )}

      <div className="workbench">
        {inConversation ? (
          <div className="conv">
            <div className="conv-scroll">
              <div className="thread">
                {submittedGoal && (
                  <div className="thread-item user">
                    <div className="thread-body">
                      <div className="thread-meta">你</div>
                      <div className="thread-text">{submittedGoal}</div>
                    </div>
                  </div>
                )}
                {events.map((ev) => (
                  <EventRow key={ev.seq} ev={ev} />
                ))}
                {running && (
                  <div className="running-line">
                    <span className="spinner" />
                    智能体执行中…
                  </div>
                )}
              </div>

              {confirmCard &&
                (() => {
                  const decided = decisions[confirmCard.confirmId];
                  return (
                    <div className="confirm-card">
                      <div className="confirm-title">需要确认：{confirmCard.tool}</div>
                      <div className="confirm-sub">该工具会访问外部资源，请确认后再执行。</div>
                      <pre className="confirm-args">{JSON.stringify(confirmCard.args, null, 2)}</pre>
                      {decided === undefined ? (
                        <div className="confirm-actions">
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
                        <span className="confirm-done">
                          <IconCheck size={14} />
                          {decided ? '已允许' : '已拒绝'}（等待执行结果…）
                        </span>
                      )}
                    </div>
                  );
                })()}
            </div>
            <div className="composer-dock">{composer}</div>
          </div>
        ) : (
          <div className="hero">
            <h1 className="hero-greet">
              AI 办公智能体，<em>我帮你</em>
            </h1>
            <p className="hero-sub">把目标交给智能体：它会调研、写文档、做表格、生成演示稿。</p>
            <div className="hero-chips">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  className="chip"
                  onClick={() => setGoal(s.goal)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {composer}
          </div>
        )}

        <aside className="rail">
          <div className="rail-head">
            <span className="rail-title">成果</span>
            <span className="rail-sub">
              {artifacts.length > 0 ? `${artifacts.length} 个文件` : '任务产出'}
            </span>
          </div>
          {artifacts.length === 0 ? (
            <div className="rail-empty">任务产出的文档会出现在这里</div>
          ) : (
            <div className="artifact-list">
              {artifacts.map((a, i) => (
                <div key={a.id || `pending-${i}`} className="artifact-card">
                  <div className={`artifact-icon ${a.kind}`}>{a.kind.toUpperCase()}</div>
                  <div className="artifact-main">
                    <div className="artifact-name">{a.filename}</div>
                    <div className="artifact-meta">
                      {formatBytes(a.size)} · v{a.version || 0} ·{' '}
                      {new Date(a.createdAt).toLocaleString()}
                    </div>
                    <div className="artifact-actions">
                      {a.id ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            void downloadArtifact(a.id, a.filename).catch((e) => setError(errorText(e)))
                          }
                        >
                          <IconDownload size={13} />
                          下载
                        </button>
                      ) : (
                        <span className="artifact-meta">落库中…</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </AppShell>
  );
}
