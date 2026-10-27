'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  App,
  Button,
  Card,
  InputNumber,
  Space,
  Switch,
  Table,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import type { AdminQaCacheItemDto } from '@ai-office/shared';
import {
  adminErrorText,
  deleteAdminQaCache,
  isForbidden,
  listAdminQaCache,
  listAdminSettings,
  resetAdminSetting,
  updateAdminSetting,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

const PAGE_SIZE = 20;
const DEFAULT_TTL = 300;
const MIN_TTL = 10;
const MAX_TTL = 86400;

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', { hour12: false });
}

export default function AdminQaCachePage() {
  const router = useRouter();
  const { modal } = App.useApp();

  const [items, setItems] = useState<AdminQaCacheItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [listFailed, setListFailed] = useState(false);

  const [enabled, setEnabled] = useState(true);
  const [ttlSeconds, setTtlSeconds] = useState<number | null>(DEFAULT_TTL);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settingsFailed, setSettingsFailed] = useState(false);
  const [settingsFromDb, setSettingsFromDb] = useState(false);

  const inFlight = useRef(false);

  const handleErr = useCallback(
    (err: unknown): boolean => {
      if (isUnauthorized(err)) {
        router.replace('/login');
        return true;
      }
      if (isForbidden(err)) {
        clearToken();
        router.replace('/login');
        return true;
      }
      setError(adminErrorText(err));
      return false;
    },
    [router],
  );

  const loadSeq = useRef(0);
  const load = useCallback(async (): Promise<boolean> => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await listAdminQaCache({ page, pageSize: PAGE_SIZE });
      // 过期响应不写状态
      if (id !== loadSeq.current) return true;
      setItems(data.items);
      setTotal(data.total);
      setListFailed(false);
      return true;
    } catch (err) {
      if (id !== loadSeq.current) return true;
      // handleErr 返回 true 表示已跳转登录：此时不再提示可重试的失败
      const redirected = handleErr(err);
      setListFailed(!redirected);
      return false;
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [page, handleErr]);

  // 写操作结束后必须调用最新的 load，避免用旧的页码闭包覆盖后续状态
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadSettings = useCallback(async (): Promise<boolean> => {
    setSettingsLoading(true);
    try {
      const rows = await listAdminSettings();
      const enabledRow = rows.find((row) => row.key === 'qaCacheEnabled');
      const ttlRow = rows.find((row) => row.key === 'qaCacheTtlSeconds');
      if (enabledRow?.type === 'boolean') setEnabled(enabledRow.value);
      if (ttlRow?.type === 'number') setTtlSeconds(ttlRow.value);
      setSettingsFromDb(enabledRow?.source === 'db' || ttlRow?.source === 'db');
      setSettingsFailed(false);
      return true;
    } catch (err) {
      setSettingsFailed(true);
      handleErr(err);
      return false;
    } finally {
      setSettingsLoading(false);
    }
  }, [handleErr]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  async function refreshAfterWrite() {
    // 写操作已成功，先给出明确提示，避免刷新失败被误判为操作失败而重复提交
    setNotice('操作已成功，正在刷新数据…');
    const ok = await loadRef.current();
    if (ok) {
      setNotice('操作已成功。');
      return;
    }
    // load 已写入具体错误；写入本身是成功的，避免同一失败显示两条告警。
    setError('');
    setNotice('操作已成功，但数据刷新失败，请勿重复提交；稍后可刷新页面确认。');
  }

  async function retryLoadSettings() {
    const ok = await loadSettings();
    // 重试成功才清掉上次加载失败的红条，避免恢复后仍显示旧错误。
    if (ok) setError('');
  }

  async function saveSettings() {
    if (inFlight.current) return;
    if (
      ttlSeconds === null ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < MIN_TTL ||
      ttlSeconds > MAX_TTL
    ) {
      setNotice('');
      setError(`缓存有效期必须是 ${MIN_TTL}–${MAX_TTL} 秒的整数`);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await updateAdminSetting('qaCacheEnabled', enabled);
      await updateAdminSetting('qaCacheTtlSeconds', ttlSeconds);
      const ok = await loadSettings();
      if (ok) {
        setSettingsFromDb(true);
        setNotice('操作已成功。');
      } else {
        setNotice('操作已成功，但设置刷新失败，请刷新页面确认。');
      }
    } catch (err) {
      // 两个 key 分两次写入：后一个失败时前一个可能已生效，先回读服务端实际值再提示错误。
      await loadSettings();
      handleErr(err);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  function resetSettings() {
    if (inFlight.current) return;
    modal.confirm({
      title: '确认恢复默认',
      content: `确认把问答缓存恢复为默认（开启，有效期 ${DEFAULT_TTL} 秒）？`,
      okText: '恢复默认',
      cancelText: '取消',
      onOk: () => runResetSettings(),
    });
  }

  async function runResetSettings() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await resetAdminSetting('qaCacheEnabled');
      await resetAdminSetting('qaCacheTtlSeconds');
      const ok = await loadSettings();
      setNotice(ok ? '操作已成功。' : '操作已成功，但设置刷新失败，请刷新页面确认。');
    } catch (err) {
      // 两个 key 分两次写入：后一个失败时前一个可能已生效，先回读服务端实际值再提示错误。
      await loadSettings();
      handleErr(err);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  function remove(item: AdminQaCacheItemDto) {
    if (inFlight.current) return;
    modal.confirm({
      title: '确认删除缓存',
      content: `确认删除问题「${item.question.slice(0, 40)}」的缓存？删除后该问题不再参考旧答案。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => runRemove(item),
    });
  }

  async function runRemove(item: AdminQaCacheItemDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await deleteAdminQaCache(item.hash);
      // 删除后当前页可能变空：回退一页，避免停在无数据页。
      if (items.length === 1 && page > 1) {
        setNotice('操作已成功。');
        setPage(page - 1);
        return;
      }
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const columns: TableColumnsType<AdminQaCacheItemDto> = [
    { title: '用户名称', dataIndex: 'userEmail', width: 220, ellipsis: true },
    { title: '会话名称', dataIndex: 'sessionTitle', width: 200, ellipsis: true },
    { title: '问题', dataIndex: 'question', width: 260, ellipsis: true },
    { title: '答案', dataIndex: 'answer', ellipsis: true },
    {
      title: '过期时间',
      dataIndex: 'expiresAt',
      width: 180,
      render: (value: string) => formatTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_: unknown, item) => (
        <Button size="small" danger disabled={busy || saving} onClick={() => remove(item)}>
          删除
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          缓存管理
        </Typography.Title>
        <Typography.Text type="secondary">
          同一用户在会话内重复提问时，BFF 会把此前的回答注入提示词供模型参考；缓存不直接返回给用户。
        </Typography.Text>
      </div>

      {error ? (
        <Alert
          type="error"
          showIcon
          message={error}
          action={
            listFailed ? (
              <Button size="small" onClick={() => void loadRef.current()}>
                重新加载
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {notice ? <Alert type="info" showIcon message={notice} /> : null}

      <Card title="缓存设置" loading={settingsLoading}>
        <Space wrap size={16} align="center">
          <Space size={8}>
            <Typography.Text>启用问答缓存</Typography.Text>
            <Switch
              checked={enabled}
              disabled={saving || busy || settingsFailed}
              aria-label="启用问答缓存"
              onChange={setEnabled}
            />
          </Space>
          <Space size={8}>
            <Typography.Text>有效期（秒）</Typography.Text>
            <InputNumber
              min={MIN_TTL}
              max={MAX_TTL}
              precision={0}
              value={ttlSeconds}
              disabled={saving || busy || settingsFailed}
              aria-label="缓存有效期（秒）"
              onChange={setTtlSeconds}
              style={{ width: 140 }}
            />
          </Space>
          <Space size={8}>
            <Button
              type="primary"
              loading={saving}
              disabled={saving || busy || settingsFailed}
              onClick={() => void saveSettings()}
            >
              保存
            </Button>
            <Button
              disabled={saving || busy || settingsFailed || !settingsFromDb}
              onClick={resetSettings}
            >
              恢复默认
            </Button>
            {settingsFailed ? (
              <Button disabled={saving} onClick={() => void retryLoadSettings()}>
                重新加载设置
              </Button>
            ) : null}
          </Space>
        </Space>
      </Card>

      <Card
        title="缓存列表"
        extra={<Typography.Text type="secondary">共 {total} 条</Typography.Text>}
      >
        <Table<AdminQaCacheItemDto>
          rowKey="hash"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 1200 }}
          locale={{ emptyText: '暂无未过期缓存' }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            onChange: setPage,
          }}
        />
      </Card>
    </Space>
  );
}
