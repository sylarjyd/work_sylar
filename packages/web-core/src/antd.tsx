'use client';

// Ant Design 5 官方 React 19 兼容补丁：修复 message/modal 等静态方法
// 在 React 19 下拿不到 App context 的问题，必须在最早进入客户端时执行。
import '@ant-design/v5-patch-for-react-19';
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { ThemeConfig } from 'antd';
import type { ReactNode } from 'react';

/**
 * 与既有 `globals.css` 品牌变量对齐：主色薄荷绿、浅灰底、细边框、10px 圆角。
 * 两个应用共用同一份主题，避免运营端与工作台观感割裂。
 */
export const ANTD_THEME: ThemeConfig = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    colorPrimary: '#00b07b',
    colorInfo: '#00b07b',
    colorLink: '#00a06f',
    colorSuccess: '#00b07b',
    colorBgLayout: '#f6f7f5',
    colorBgContainer: '#ffffff',
    colorBorderSecondary: '#e8eae6',
    colorText: '#1d2421',
    colorTextSecondary: '#5f6b64',
    borderRadius: 10,
    borderRadiusLG: 12,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  components: {
    Layout: {
      siderBg: '#ffffff',
      headerBg: '#ffffff',
      bodyBg: '#f6f7f5',
      triggerBg: '#ffffff',
    },
    Menu: {
      itemBorderRadius: 8,
      itemSelectedBg: 'rgba(0, 176, 123, 0.12)',
      itemSelectedColor: '#007d58',
      itemHoverBg: 'rgba(0, 176, 123, 0.06)',
      groupTitleColor: '#8a958f',
    },
    Table: {
      headerBg: '#f6f7f5',
      headerSplitColor: '#e8eae6',
      borderColor: '#eef0ec',
    },
    Card: {
      borderRadiusLG: 12,
    },
    Button: {
      primaryShadow: 'none',
      defaultShadow: 'none',
    },
  },
};

/** 两个应用根布局共用：中文语言包 + 品牌主题 + App 上下文（供 App.useApp 使用）。 */
export function AntdProvider({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider locale={zhCN} theme={ANTD_THEME}>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}
