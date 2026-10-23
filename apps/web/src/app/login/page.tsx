'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Form, Input } from 'antd';
import { IconSpark } from '../../components/icons';
import { authErrorMessage, login, register } from '../../lib/api';

interface LoginValues {
  email: string;
  password: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [form] = Form.useForm<LoginValues>();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(values: LoginValues) {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await login(values.email, values.password);
      else await register(values.email, values.password);
      router.push('/');
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function switchMode() {
    setMode(mode === 'login' ? 'register' : 'login');
    setError('');
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

          <Form<LoginValues>
            form={form}
            layout="vertical"
            requiredMark={false}
            className="login-form"
            disabled={busy}
            onFinish={(values) => void submit(values)}
          >
            <Form.Item
              label="邮箱"
              name="email"
              rules={[
                { required: true, message: '请输入邮箱地址' },
                { type: 'email', message: '邮箱格式不正确' },
              ]}
            >
              <Input
                type="email"
                size="large"
                autoComplete="email"
                placeholder="请输入邮箱地址"
              />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password
                size="large"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder="请输入密码"
              />
            </Form.Item>

            {error ? (
              <Form.Item>
                <Alert type="error" showIcon message={error} />
              </Form.Item>
            ) : null}

            <Button type="primary" htmlType="submit" size="large" block loading={busy}>
              {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册'}
            </Button>
          </Form>

          <div className="login-switch">
            {mode === 'login' ? '还没有账号？' : '已有账号？'}
            <Button
              type="link"
              size="small"
              disabled={busy}
              onClick={switchMode}
              style={{ paddingInline: 4 }}
            >
              {mode === 'login' ? '立即注册' : '去登录'}
            </Button>
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
