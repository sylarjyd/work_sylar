'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentEvent, ArtifactDto, SessionSummary } from '@ai-office/shared';
import { createSseParser } from '../lib/sse-parser';
import {
  clearToken,
  createSession,
  downloadArtifact,
  getToken,
  isUnauthorized,
  listArtifacts,
  listSessions,
  streamTask,
} from '../lib/api';
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
    void refreshArtifacts(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

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

  return (
    <main>
      <h1>AI 办公智能体 · M1 工作台</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} style={{ padding: 8 }}>
          <option value="">（新会话）</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>{s.title}</option>
          ))}
        </select>
        <button onClick={() => void handleNewSession()}>新建会话</button>
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
