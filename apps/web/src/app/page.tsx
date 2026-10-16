'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentEvent, ArtifactDto, SessionSummary } from '@ai-office/shared';
import { createSseParser } from '../lib/sse-parser';
import {
  clearToken,
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

export default function Home() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>('');
  const [goal, setGoal] = useState('调研竞品并给出结论');
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
      setError(String(err));
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
      setError(String(err));
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

  async function handleNewSession() {
    try {
      await newSession();
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(String(err));
    }
  }

  async function run() {
    setEvents([]);
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
      setError(String(err));
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
      setError(String(err));
    }
  }

  return (
    <main>
      <h1>AI 办公智能体 · M1 工作台</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} disabled={running} style={{ padding: 8 }}>
          <option value="">（新会话）</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>{s.title}</option>
          ))}
        </select>
        <button onClick={() => void handleNewSession()} disabled={running}>新建会话</button>
        <button
          onClick={() => { clearToken(); router.push('/login'); }}
          style={{ marginLeft: 'auto' }}
        >
          退出
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input value={goal} onChange={(e) => setGoal(e.target.value)} style={{ flex: 1, padding: 8 }} />
        <button onClick={run} disabled={running}>{running ? '执行中…' : '开始'}</button>
      </div>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <ol>
        {events.map((ev) => (
          <li key={ev.seq}>{renderStep(ev)}</li>
        ))}
      </ol>
      {(() => {
        const card = currentConfirmCard(events);
        if (!card) return null;
        const decided = decisions[card.confirmId];
        return (
          <div style={{ border: '1px solid #f0ad4e', borderRadius: 6, padding: 12, marginTop: 12 }}>
            <div style={{ fontWeight: 600 }}>需要确认：{card.tool}</div>
            <pre style={{ whiteSpace: 'pre-wrap', background: '#f7f7f7', padding: 8, borderRadius: 4 }}>
              {JSON.stringify(card.args, null, 2)}
            </pre>
            {decided === undefined ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => void decide(card.confirmId, true)}>允许</button>
                <button onClick={() => void decide(card.confirmId, false)}>拒绝</button>
              </div>
            ) : (
              <span style={{ color: '#666' }}>{decided ? '已允许' : '已拒绝'}（等待执行结果…）</span>
            )}
          </div>
        );
      })()}
      <h2 style={{ marginTop: 24 }}>成果区</h2>
      {artifacts.length === 0 ? (
        <p style={{ color: '#888' }}>暂无产出</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {artifacts.map((a, i) => (
            <li key={a.id || `pending-${i}`} style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, marginBottom: 8 }}>
              <div style={{ fontWeight: 600 }}>{a.filename}</div>
              <div style={{ color: '#666', fontSize: 13 }}>
                {a.kind} · {a.size} 字节 · v{a.version} · {new Date(a.createdAt).toLocaleString()}
              </div>
              {a.id ? (
                <button
                  style={{ marginTop: 8 }}
                  onClick={() => void downloadArtifact(a.id, a.filename).catch((e) => setError(String(e)))}
                >
                  下载
                </button>
              ) : (
                <span style={{ color: '#999', fontSize: 13 }}>落库中…</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
