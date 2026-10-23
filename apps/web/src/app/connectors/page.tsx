'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Input,
  List,
  Row,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { ApiOutlined, DeleteOutlined, LockOutlined, PlusOutlined } from '@ant-design/icons';
import type { ConnectorDto } from '@ai-office/shared';
import { AppShell } from '../../components/app-shell';
import { errorText } from '@ai-office/web-core';
import {
  createConnector,
  deleteConnector,
  getRole,
  getToken,
  isUnauthorized,
  listConnectors,
  updateConnector,
} from '../../lib/api';

type EnvRow = { key: string; value: string };

const EMPTY_ENV: EnvRow[] = [{ key: '', value: '' }];

export default function ConnectorsPage() {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [items, setItems] = useState<ConnectorDto[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [togglingId, setTogglingId] = useState('');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envRows, setEnvRows] = useState<EnvRow[]>(EMPTY_ENV);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [showForm, setShowForm] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setItems(await listConnectors());
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    }
  }, [router]);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    const role = getRole();
    if (role === 'admin') {
      setIsAdmin(true);
      void refresh();
      return;
    }
    if (role) {
      // 普通成员无权读取连接器列表：不发起请求，避免无意义的 403 报错。
      setIsAdmin(false);
      return;
    }
    // 旧 token 未记录角色：用一次拉取探测权限，403 视为普通成员。
    void (async () => {
      try {
        setItems(await listConnectors());
        setIsAdmin(true);
      } catch (err) {
        if (isUnauthorized(err)) {
          router.push('/login');
          return;
        }
        if (err instanceof Error && err.message === 'connectors_failed_403') {
          setIsAdmin(false);
          return;
        }
        setIsAdmin(false);
        setError(errorText(err));
      }
    })();
  }, [refresh, router]);

  function resetForm() {
    setName('');
    setCommand('');
    setArgsText('');
    setEnvRows(EMPTY_ENV);
    setShowForm(false);
  }

  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const env = Object.fromEntries(
        envRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]),
      );
      const args = argsText.trim() ? argsText.trim().split(/\s+/) : [];
      const created = await createConnector({ name: name.trim(), command: command.trim(), args, env });
      setItems((prev) => [created, ...prev]);
      message.success(`已添加「${created.name}」，校验通过`);
      resetForm();
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function toggle(item: ConnectorDto) {
    if (togglingId) return;
    setTogglingId(item.id);
    setError('');
    try {
      const updated = await updateConnector(item.id, { enabled: !item.enabled });
      setItems((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    } catch (err) {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    } finally {
      setTogglingId('');
    }
  }

  function remove(item: ConnectorDto) {
    modal.confirm({
      title: '删除连接器',
      content: `确认删除「${item.name}」？其提供的 ${item.toolCount} 个工具将不再出现在智能体工具箱中。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteConnector(item.id);
          setItems((prev) => prev.filter((c) => c.id !== item.id));
          message.success(`已删除「${item.name}」`);
        } catch (err) {
          if (isUnauthorized(err)) {
            router.push('/login');
            return;
          }
          setError(errorText(err));
        }
      },
    });
  }

  const canSubmit = !busy && name.trim() !== '' && command.trim() !== '';

  return (
    <AppShell active="connectors">
      <div className="page-scroll">
        <div className="page">
          <header className="page-head">
            <div>
              <h1 className="page-title">连接器</h1>
              <p className="page-sub">
                接入外部 MCP Server，其工具会自动出现在智能体的工具箱里。
              </p>
            </div>
            {isAdmin ? (
              <div className="page-head-actions">
                <Button
                  type={showForm ? 'default' : 'primary'}
                  icon={showForm ? undefined : <PlusOutlined />}
                  onClick={() => setShowForm((v) => !v)}
                >
                  {showForm ? '收起' : '新增连接器'}
                </Button>
              </div>
            ) : null}
          </header>

          {error ? (
            <Alert
              type="error"
              showIcon
              message={error}
              closable
              onClose={() => setError('')}
              style={{ marginBottom: 16 }}
            />
          ) : null}

          {isAdmin === null ? null : !isAdmin ? (
            <Alert
              type="info"
              showIcon
              icon={<LockOutlined />}
              message="需要管理员权限"
              description="连接器由管理员统一配置。如需接入新的 MCP Server，请联系所在组织的管理员。"
            />
          ) : (
            <>
              {showForm ? (
                <Card
                  size="small"
                  title="新增 MCP Server"
                  style={{ marginBottom: 16 }}
                  extra={
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      保存前会实际拉起子进程校验工具列表，校验失败不会入库
                    </Typography.Text>
                  }
                >
                  <Row gutter={[16, 0]}>
                    <Col xs={24} md={12}>
                      <div className="admin-field">
                        <Typography.Text>名称</Typography.Text>
                        <Input
                          placeholder="租户内唯一，如 filesystem"
                          value={name}
                          disabled={busy}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </div>
                    </Col>
                    <Col xs={24} md={12}>
                      <div className="admin-field">
                        <Typography.Text>启动命令</Typography.Text>
                        <Input
                          placeholder="如 npx"
                          value={command}
                          disabled={busy}
                          onChange={(e) => setCommand(e.target.value)}
                        />
                      </div>
                    </Col>
                    <Col span={24}>
                      <div className="admin-field">
                        <Typography.Text>参数</Typography.Text>
                        <Input
                          placeholder="-y @modelcontextprotocol/server-filesystem /data"
                          value={argsText}
                          disabled={busy}
                          onChange={(e) => setArgsText(e.target.value)}
                        />
                      </div>
                    </Col>
                    <Col span={24}>
                      <div className="admin-field">
                        <Typography.Text>环境变量（密钥加密入库）</Typography.Text>
                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                          {envRows.map((row, i) => (
                            <Space.Compact key={i} style={{ width: '100%' }}>
                              <Input
                                style={{ width: '40%' }}
                                placeholder="变量名"
                                value={row.key}
                                disabled={busy}
                                onChange={(e) =>
                                  setEnvRows((p) =>
                                    p.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)),
                                  )
                                }
                              />
                              <Input.Password
                                placeholder="变量值"
                                autoComplete="new-password"
                                value={row.value}
                                disabled={busy}
                                onChange={(e) =>
                                  setEnvRows((p) =>
                                    p.map((r, j) =>
                                      j === i ? { ...r, value: e.target.value } : r,
                                    ),
                                  )
                                }
                              />
                              <Button
                                danger
                                icon={<DeleteOutlined />}
                                disabled={busy}
                                aria-label="删除变量"
                                onClick={() => setEnvRows((p) => p.filter((_, j) => j !== i))}
                              />
                            </Space.Compact>
                          ))}
                          <Button
                            size="small"
                            icon={<PlusOutlined />}
                            disabled={busy}
                            onClick={() => setEnvRows((p) => [...p, { key: '', value: '' }])}
                          >
                            添加变量
                          </Button>
                        </Space>
                      </div>
                    </Col>
                    <Col span={24}>
                      <Space>
                        <Button type="primary" loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
                          {busy ? '校验中…' : '校验并添加'}
                        </Button>
                        <Button disabled={busy} onClick={resetForm}>
                          取消
                        </Button>
                      </Space>
                    </Col>
                  </Row>
                </Card>
              ) : null}

              <Card size="small" title="已接入的连接器" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>共 {items.length} 个</Typography.Text>}>
                {items.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={
                      <Space direction="vertical" size={2}>
                        <Typography.Text>还没有连接器</Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          新增一个 MCP Server 后，其工具会自动出现在智能体的工具箱里。
                        </Typography.Text>
                      </Space>
                    }
                  >
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowForm(true)}>
                      新增连接器
                    </Button>
                  </Empty>
                ) : (
                  <List
                    dataSource={items}
                    rowKey="id"
                    renderItem={(c) => (
                      <List.Item
                        actions={[
                          <Space key="switch" size={6}>
                            <Switch
                              size="small"
                              checked={c.enabled}
                              loading={togglingId === c.id}
                              aria-label={`${c.enabled ? '停用' : '启用'} ${c.name}`}
                              onChange={() => void toggle(c)}
                            />
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {c.enabled ? '已启用' : '已停用'}
                            </Typography.Text>
                          </Space>,
                          <Button
                            key="delete"
                            size="small"
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            aria-label={`删除 ${c.name}`}
                            onClick={() => remove(c)}
                          >
                            删除
                          </Button>,
                        ]}
                      >
                        <List.Item.Meta
                          avatar={<ApiOutlined style={{ fontSize: 20, color: '#00b07b' }} />}
                          title={
                            <Space size={8} wrap>
                              <Typography.Text strong>{c.name}</Typography.Text>
                              <Tag>{c.toolCount} 个工具</Tag>
                              {c.enabled ? <Tag color="success">已启用</Tag> : <Tag>已停用</Tag>}
                            </Space>
                          }
                          description={
                            <Space direction="vertical" size={2}>
                              <Typography.Text code style={{ fontSize: 12 }}>
                                {c.command} {c.args.join(' ')}
                              </Typography.Text>
                              {c.lastValidatedAt ? (
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  校验于 {new Date(c.lastValidatedAt).toLocaleString('zh-CN', { hour12: false })}
                                </Typography.Text>
                              ) : null}
                            </Space>
                          }
                        />
                      </List.Item>
                    )}
                  />
                )}
              </Card>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
