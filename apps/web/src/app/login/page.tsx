'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { login, register } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password);
      router.push('/');
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <main>
      <h1>{mode === 'login' ? '登录' : '注册'}</h1>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 320 }}>
        <input placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} style={{ padding: 8 }} />
        <input
          placeholder="密码"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ padding: 8 }}
        />
        <button type="submit" style={{ padding: 8 }}>{mode === 'login' ? '登录' : '注册'}</button>
      </form>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <button
        onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        style={{ marginTop: 8, background: 'none', border: 'none', color: 'blue', cursor: 'pointer' }}
      >
        {mode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
      </button>
    </main>
  );
}
