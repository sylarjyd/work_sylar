'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { authErrorMessage, clearToken, getRole, login } from '@ai-office/web-core';

interface LoginValues {
  email: string;
  password: string;
}

export default function AdminLoginPage() {
  const router = useRouter();
  const [form] = Form.useForm<LoginValues>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 已登录管理员直接进入概览；普通账号停留在登录页等待管理员账号。
  useEffect(() => {
    if (getRole() === 'admin') router.replace('/overview');
  }, [router]);

  async function submit(values: LoginValues) {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const data = await login(values.email, values.password);
      if (data.user.role !== 'admin') {
        // 非管理员不能进入运营端：清掉刚写入的 token，避免下次被误判为已登录。
        clearToken();
        setError('当前账号没有运营平台访问权限');
        return;
      }
      router.replace('/overview');
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

      <div className="login-brand">
        <div className="brand-mark">管</div>
        <div>
          <div className="brand-name">AI 办公智能体</div>
          <div className="brand-sub">运营平台</div>
        </div>
      </div>

      <div className="login-main">
        <div className="login-card">
          <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>
            运营平台登录
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 20 }}>
            仅限平台运营人员访问，请使用管理员账号登录
          </Typography.Paragraph>

          <Form<LoginValues>
            form={form}
            layout="vertical"
            requiredMark={false}
            onFinish={(values) => void submit(values)}
            disabled={busy}
          >
            <Form.Item
              label="邮箱"
              name="email"
              rules={[{ required: true, message: '请输入管理员邮箱' }]}
            >
              <Input
                type="email"
                autoComplete="email"
                placeholder="请输入管理员邮箱"
                size="large"
              />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password
                autoComplete="current-password"
                placeholder="请输入密码"
                size="large"
              />
            </Form.Item>

            {error ? (
              <Form.Item>
                <Alert type="error" showIcon message={error} />
              </Form.Item>
            ) : null}

            <Form.Item style={{ marginBottom: 8 }}>
              <Button type="primary" htmlType="submit" block size="large" loading={busy}>
                {busy ? '请稍候…' : '登录'}
              </Button>
            </Form.Item>
          </Form>

          <Typography.Paragraph type="secondary" className="login-legal">
            运营平台通常部署于内网，请勿在公网环境直接暴露。
            <br />
            普通用户请在客户工作台注册并登录。
          </Typography.Paragraph>
        </div>
      </div>

      <div className="login-foot">AI 办公智能体 · 平台运营</div>
    </main>
  );
}
