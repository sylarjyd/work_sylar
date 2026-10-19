'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { IconSpark } from '../../components/icons';
import { authErrorMessage, login, register } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password);
      router.push('/');
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <svg className="login-deco login-hills" viewBox="0 0 640 320" fill="none" aria-hidden="true">
        <path
          d="M-20 300L140 168L232 240L362 108L520 258L660 198"
          stroke="rgba(84,78,136,0.26)"
          strokeWidth="1.4"
        />
        <path
          d="M-20 334L182 218L300 292L432 168L562 302L660 250"
          stroke="rgba(84,78,136,0.16)"
          strokeWidth="1.1"
        />
        <path
          d="M470 74L610 24M498 108L638 58M540 146L660 104"
          stroke="rgba(255,255,255,0.55)"
          strokeWidth="1"
          strokeLinecap="round"
        />
      </svg>

      <svg className="login-deco login-orbit" viewBox="0 0 180 180" fill="none" aria-hidden="true">
        <circle cx="90" cy="90" r="62" stroke="rgba(255,255,255,0.6)" strokeWidth="1" />
        <circle
          cx="90"
          cy="90"
          r="40"
          stroke="rgba(0,176,123,0.35)"
          strokeWidth="1"
          strokeDasharray="3 6"
        />
        <circle cx="90" cy="90" r="13" fill="rgba(255,255,255,0.5)" />
      </svg>

      <IconSpark className="login-deco login-spark" size={56} />

      <div className="login-brand">
        <div className="brand-mark">
          <IconSpark size={17} />
        </div>
        <div>
          <div className="brand-name">AI 办公智能体</div>
          <div className="brand-sub">智能工作台</div>
        </div>
      </div>

      <div className="login-main">
        <div className="login-card">
          <h1 className="login-title">{mode === 'login' ? '欢迎回来' : '创建账号'}</h1>
          <p className="login-sub">
            {mode === 'login' ? '登录后，把工作交给智能体' : '注册后即可开始你的第一个智能任务'}
          </p>

          <form className="login-form" onSubmit={submit}>
            <div className="field">
              <label className="field-label" htmlFor="email">
                邮箱
              </label>
              <input
                id="email"
                className="input"
                type="email"
                required
                autoComplete="email"
                placeholder="请输入邮箱地址"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="password">
                密码
              </label>
              <input
                id="password"
                className="input"
                type="password"
                required
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder="请输入密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && (
              <div className="banner banner-error login-error" role="alert">
                {error}
              </div>
            )}
            <button type="submit" className="btn btn-mint" disabled={busy}>
              {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册'}
            </button>
          </form>

          <div className="login-switch">
            {mode === 'login' ? '还没有账号？' : '已有账号？'}
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError('');
              }}
            >
              {mode === 'login' ? '立即注册' : '去登录'}
            </button>
          </div>

          <p className="login-legal">
            登录即表示你已阅读并同意平台使用规范。
            <br />
            账号与数据按组织隔离，仅用于本组织内的工作任务。
          </p>
        </div>
      </div>

      <div className="login-foot">AI 办公智能体 · 让智能体替你完成工作</div>
    </main>
  );
}
