'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentEvent, SessionSummary } from '@ai-office/shared';
import { createSseParser } from '../lib/sse-parser';
import { clearToken, createSession, getToken, listSessions, streamTask } from '../lib/api';
import { renderStep } from '../lib/render-step';

export default function Home() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>('');
  const [goal, setGoal] = useState('调研竞品并给出结论');
  const [events, setEvents] = useState<AgentEvent[]>([]);
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
      setError(String(err));
    }
  }

  async function newSession() {
    const s = await createSession();
    setSessions((prev) => [s, ...prev]);
    setSessionId(s.id);
  }

  async function run() {
    if (!sessionId) await newSession();
    setEvents([]);
    setRunning(true);
    setError('');
    try {
      const res = await streamTask(sessionId, goal);
      if (!res.body) throw new Error('no body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parse = createSseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const m of parse(decoder.decode(value, { stream: true }))) {
          if (m.event === 'step') setEvents((prev) => [...prev, m.data as AgentEvent]);
          if (m.event === 'error') setError(JSON.stringify(m.data));
        }
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
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
        <button onClick={newSession}>新建会话</button>
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
    </main>
  );
}
