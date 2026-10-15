'use client';

import { useState } from 'react';
import type { AgentEvent, SseMessage } from '@ai-office/shared';
import { createSseParser } from '../lib/sse-parser';

const BFF_URL = process.env.NEXT_PUBLIC_BFF_URL ?? 'http://localhost:4000';

export default function Home() {
  const [goal, setGoal] = useState('调研竞品并生成一份 PPT');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);

  async function run() {
    setEvents([]);
    setRunning(true);
    try {
      const res = await fetch(`${BFF_URL}/api/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal }),
      });
      if (!res.body) throw new Error('no body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parse = createSseParser();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const messages: SseMessage[] = parse(decoder.decode(value, { stream: true }));
        for (const m of messages) {
          if (m.event === 'step') setEvents((prev) => [...prev, m.data as AgentEvent]);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main>
      <h1>AI 办公智能体 · M0 管道验证</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={run} disabled={running}>
          {running ? '执行中…' : '开始'}
        </button>
      </div>
      <ol>
        {events.map((ev) => (
          <li key={ev.seq}>
            <b>[{ev.type}]</b> {JSON.stringify(ev.payload)}
          </li>
        ))}
      </ol>
    </main>
  );
}
