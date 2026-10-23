'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Layout, Menu, Spin, Typography } from 'antd';
import {
  AlertOutlined,
  ApiOutlined,
  CrownOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  LogoutOutlined,
  MessageOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TagsOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { clearToken, getRole } from '@ai-office/web-core';
import { ADMIN_NAV, selectedNavKey } from '../lib/admin-nav';
import { adminRedirectPath } from '../lib/admin-guard';

const { Sider, Content } = Layout;

// 构建期内联：未配置时生产环境不显示“返回工作台”。运营端与客户端通常是不同 origin。
const WORKSPACE_URL =
  process.env.NEXT_PUBLIC_WORKSPACE_URL ||
  (process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : '');

const ICONS: Record<string, ReactNode> = {
  '/overview': <DashboardOutlined />,
  '/alerts': <AlertOutlined />,
  '/users': <TeamOutlined />,
  '/tenants': <CrownOutlined />,
  '/plans': <TagsOutlined />,
  '/sessions': <MessageOutlined />,
  '/tasks': <ThunderboltOutlined />,
  '/kb': <DatabaseOutlined />,
  '/models': <ApiOutlined />,
  '/settings': <SettingOutlined />,
  '/audit': <SafetyCertificateOutlined />,
};

export function AdminShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  // 角色只在挂载后读取：SSR 阶段没有 localStorage。
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const redirect = adminRedirectPath(getRole());
    if (redirect) {
      router.replace(redirect);
      return;
    }
    setReady(true);
  }, [router]);

  function logout() {
    clearToken();
    router.replace('/login');
  }

  if (!ready) {
    return (
      <div className="admin-loading">
        <Spin /> 校验权限…
      </div>
    );
  }

  const menuItems = ADMIN_NAV.map((group) => ({
    type: 'group' as const,
    key: group.key,
    label: group.label,
    children: group.items.map((item) => ({
      key: item.href,
      icon: ICONS[item.href],
      label: <Link href={item.href}>{item.label}</Link>,
    })),
  }));

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        width={232}
        theme="light"
        style={{ position: 'sticky', top: 0, height: '100vh', borderRight: '1px solid #e8eae6' }}
      >
        <div style={{ padding: '20px 20px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              aria-hidden
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                background: '#00b07b',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                fontWeight: 700,
              }}
            >
              管
            </div>
            <div>
              <Typography.Text strong style={{ fontSize: 15 }}>
                运营平台
              </Typography.Text>
              <div style={{ fontSize: 12, color: '#8a958f' }}>AI 办公智能体</div>
            </div>
          </div>
        </div>

        <nav aria-label="管理导航">
          <Menu
            mode="inline"
            selectedKeys={[selectedNavKey(pathname)]}
            items={menuItems}
            style={{ borderInlineEnd: 'none', padding: '0 8px' }}
          />
        </nav>

        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: 16,
            borderTop: '1px solid #eef0ec',
            display: 'flex',
            gap: 8,
          }}
        >
          {WORKSPACE_URL ? (
            <Button href={WORKSPACE_URL} target="_blank" rel="noreferrer" style={{ flex: 1 }}>
              返回工作台
            </Button>
          ) : null}
          <Button icon={<LogoutOutlined />} onClick={logout} title="退出登录">
            退出
          </Button>
        </div>
      </Sider>
      <Content style={{ padding: 24, background: '#f6f7f5' }}>{children}</Content>
    </Layout>
  );
}
