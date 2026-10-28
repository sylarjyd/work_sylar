'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Layout, Menu, Spin, Typography } from 'antd';
import {
  AlertOutlined,
  ApiOutlined,
  AuditOutlined,
  BookOutlined,
  CloudServerOutlined,
  CommentOutlined,
  ContactsOutlined,
  CrownOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DeploymentUnitOutlined,
  DesktopOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  MonitorOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TagsOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  BulbOutlined,
} from '@ant-design/icons';
import { clearToken, getRole } from '@ai-office/web-core';
import { ADMIN_NAV, ADMIN_NAV_ITEMS, selectedNavKey } from '../lib/admin-nav';
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
  '/skills': <BulbOutlined />,
  '/models': <ApiOutlined />,
  '/settings': <SettingOutlined />,
  '/qa-cache': <CloudServerOutlined />,
  '/audit': <SafetyCertificateOutlined />,
};

// 一级分组图标与叶子图标区分开，避免父子重复同一符号。
const GROUP_ICONS: Record<string, ReactNode> = {
  monitor: <MonitorOutlined />,
  customers: <ContactsOutlined />,
  conversations: <CommentOutlined />,
  knowledge: <BookOutlined />,
  skills: <RocketOutlined />,
  models: <DeploymentUnitOutlined />,
  security: <AuditOutlined />,
};

export function AdminShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  // 角色只在挂载后读取：SSR 阶段没有 localStorage。
  const [ready, setReady] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // 默认全部收起，只露出分组；用户在本次会话内的展开选择在路由切换间保留。
  const [openKeys, setOpenKeys] = useState<string[]>([]);

  useEffect(() => {
    const redirect = adminRedirectPath(getRole());
    if (redirect) {
      router.replace(redirect);
      return;
    }
    setReady(true);
  }, [router]);

  // 折叠状态同样只在挂载后读取，避免 SSR 与水合结果不一致；窄屏默认收起。
  useEffect(() => {
    const stored = window.localStorage.getItem('admin.sidebar.collapsed');
    if (stored === '1') setCollapsed(true);
    else if (stored === '0') setCollapsed(false);
    else if (window.matchMedia('(max-width: 960px)').matches) setCollapsed(true);
  }, []);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    window.localStorage.setItem('admin.sidebar.collapsed', next ? '1' : '0');
  }

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

  const navItem = (item: (typeof ADMIN_NAV_ITEMS)[number]) => ({
    key: item.href,
    icon: ICONS[item.href],
    // 折叠时 AntD 用 title 作为图标 tooltip；显式给字符串避免把 Link 塞进 tooltip。
    title: item.label,
    label: <Link href={item.href}>{item.label}</Link>,
  });

  // 分组做二级菜单，可点击标题收起/展开，独立页面直接作为一级菜单；
  // 折叠后只保留图标轨，分组标题在 80px 内会被截断，因此改为扁平列表。
  const menuItems = collapsed
    ? ADMIN_NAV_ITEMS.map(navItem)
    : ADMIN_NAV.map((entry) =>
        'href' in entry
          ? navItem({ href: entry.href, label: entry.label })
          : {
              key: entry.key,
              icon: GROUP_ICONS[entry.key],
              label: entry.label,
              children: entry.items.map(navItem),
            },
      );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        id="admin-sidebar"
        aria-label="管理导航侧栏"
        width={232}
        collapsedWidth={80}
        collapsed={collapsed}
        trigger={null}
        theme="light"
        style={{ position: 'sticky', top: 0, height: '100vh', borderRight: '1px solid #e8eae6' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div
            style={{
              padding: collapsed ? '20px 0 12px' : '20px 16px 12px',
              display: 'flex',
              flexDirection: collapsed ? 'column' : 'row',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                minWidth: 0,
                flex: collapsed ? '0 0 auto' : 1,
              }}
            >
              <div
                aria-hidden
                style={{
                  width: 36,
                  height: 36,
                  flex: '0 0 auto',
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
              {!collapsed && (
                <div style={{ minWidth: 0 }}>
                  <Typography.Text strong style={{ fontSize: 15, whiteSpace: 'nowrap' }}>
                    运营平台
                  </Typography.Text>
                  <div style={{ fontSize: 12, color: '#8a958f', whiteSpace: 'nowrap' }}>
                    AI 办公智能体
                  </div>
                </div>
              )}
            </div>
            <Button
              type="text"
              size="small"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={toggleCollapsed}
              aria-label={collapsed ? '展开菜单' : '收起菜单'}
              aria-controls="admin-sidebar"
              aria-expanded={!collapsed}
              title={collapsed ? '展开菜单' : '收起菜单'}
              style={{ flex: '0 0 auto' }}
            />
          </div>

          <nav
            aria-label="管理导航"
            style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
          >
            <Menu
              mode="inline"
              inlineCollapsed={collapsed}
              selectedKeys={[selectedNavKey(pathname)]}
              items={menuItems}
              {...(collapsed ? {} : { openKeys, onOpenChange: setOpenKeys })}
              style={{ borderInlineEnd: 'none', padding: '0 8px' }}
            />
          </nav>

          <div
            style={{
              flexShrink: 0,
              padding: collapsed ? 12 : 16,
              borderTop: '1px solid #eef0ec',
              display: 'flex',
              flexDirection: collapsed ? 'column' : 'row',
              gap: 8,
            }}
          >
            {WORKSPACE_URL ? (
              <Button
                href={WORKSPACE_URL}
                target="_blank"
                rel="noreferrer"
                icon={<DesktopOutlined />}
                title="返回工作台"
                style={{ flex: collapsed ? undefined : 1 }}
              >
                {!collapsed && '返回工作台'}
              </Button>
            ) : null}
            <Button
              icon={<LogoutOutlined />}
              onClick={logout}
              title="退出登录"
              aria-label={collapsed ? '退出登录' : undefined}
            >
              {!collapsed && '退出'}
            </Button>
          </div>
        </div>
      </Sider>
      <Content style={{ padding: 24, background: '#f6f7f5' }}>{children}</Content>
    </Layout>
  );
}
