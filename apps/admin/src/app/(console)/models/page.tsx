'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Drawer,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  MODEL_CAPABILITIES,
  MODEL_CAPABILITY_LABELS,
  MODEL_MODALITIES,
  MODEL_MODALITY_LABELS,
  type AdminModelDto,
  type AdminModelsDto,
  type AdminModelTestResultDto,
  type ModelCapability,
  type ModelModality,
} from '@ai-office/shared';
import {
  adminErrorText,
  createAdminModel,
  createModelProvider,
  deleteAdminModel,
  deleteModelProvider,
  getAdminModels,
  isForbidden,
  setDefaultModel,
  testAdminModel,
  updateAdminModel,
  updateModelProvider,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

/** 与数据库 int 上限保持一致，避免提交后才由服务端报错。 */
const MAX_MILLI_CREDITS = 2_147_483_647;

function parseAmount(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MILLI_CREDITS) return null;
  return value;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function numberText(v: number | null): string {
  return v === null ? '' : String(v);
}

interface ProviderForm {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}

interface ModelForm {
  editing: boolean;
  model: string;
  displayName: string;
  providerId: string;
  enabled: boolean;
  capabilities: ModelCapability[];
  modalities: ModelModality[];
  sortOrder: string;
  input: string;
  output: string;
}

function emptyModelForm(providerId = ''): ModelForm {
  return {
    editing: false,
    model: '',
    displayName: '',
    providerId,
    enabled: false,
    capabilities: ['chat'],
    modalities: ['text'],
    sortOrder: '0',
    input: '0',
    output: '0',
  };
}

export default function AdminModelsPage() {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [data, setData] = useState<AdminModelsDto | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderForm | null>(null);
  const [modelForm, setModelForm] = useState<ModelForm | null>(null);
  const [testResults, setTestResults] = useState<Record<string, AdminModelTestResultDto>>({});
  const [capFilter, setCapFilter] = useState<'all' | ModelCapability>('all');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const loadSeq = useRef(0);
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

  const load = useCallback(async (): Promise<boolean> => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const next = await getAdminModels();
      if (id !== loadSeq.current) return true;
      setData(next);
      return true;
    } catch (err) {
      if (id !== loadSeq.current) return true;
      return !handleErr(err);
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [handleErr]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refreshAfterWrite() {
    setNotice('操作已成功，正在刷新数据…');
    const ok = await loadRef.current();
    setNotice(ok ? '操作已成功。' : '操作已成功，但数据刷新失败，请勿重复提交；稍后可刷新页面确认。');
  }

  async function saveProvider() {
    if (!providerForm || inFlight.current) return;
    setError('');
    setNotice('');
    if (!providerForm.name.trim() || !providerForm.baseUrl.trim()) {
      void message.error('厂商名称和 Base URL 不能为空');
      return;
    }
    if (!providerForm.id && !providerForm.apiKey.trim()) {
      void message.error('新增厂商必须填写 API Key');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      if (providerForm.id) {
        await updateModelProvider(providerForm.id, {
          name: providerForm.name.trim(),
          baseUrl: providerForm.baseUrl.trim(),
          ...(providerForm.apiKey.trim() ? { apiKey: providerForm.apiKey.trim() } : {}),
        });
      } else {
        await createModelProvider({
          name: providerForm.name.trim(),
          baseUrl: providerForm.baseUrl.trim(),
          apiKey: providerForm.apiKey.trim(),
        });
      }
      setProviderForm(null);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function removeProvider(id: string, name: string) {
    if (inFlight.current) return;
    modal.confirm({
      title: '确认删除厂商',
      content: `确认删除厂商「${name}」？厂商下仍有模型时会被拒绝。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => runRemoveProvider(id),
    });
  }

  async function runRemoveProvider(id: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await deleteModelProvider(id);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function saveModel() {
    if (!modelForm || inFlight.current) return;
    setError('');
    setNotice('');
    const name = modelForm.model.trim();
    if (!name) {
      void message.error('模型名不能为空');
      return;
    }
    if (!modelForm.providerId) {
      void message.error('必须选择厂商');
      return;
    }
    const input = parseAmount(modelForm.input);
    const output = parseAmount(modelForm.output);
    const order = Number(modelForm.sortOrder);
    if (input === null || output === null) {
      void message.error('输入/输出必须是非负整数');
      return;
    }
    if (!Number.isSafeInteger(order) || order < 0 || order > 1_000_000) {
      void message.error('排序必须是非负整数');
      return;
    }
    if (modelForm.capabilities.length === 0) {
      void message.error('请至少选择一种模型分类');
      return;
    }
    if (modelForm.modalities.length === 0) {
      void message.error('请至少选择一种模态');
      return;
    }
    modal.confirm({
      title: modelForm.editing ? '确认更新模型' : '确认新增模型',
      content: `确认${modelForm.editing ? '更新' : '新增'}模型「${name}」？`,
      okText: '保存',
      cancelText: '取消',
      onOk: () => runSaveModel(name, input, output, order),
    });
  }

  async function runSaveModel(name: string, input: number, output: number, order: number) {
    if (!modelForm || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const prices = { inputMilliCreditsPer1k: input, outputMilliCreditsPer1k: output };
      const displayName = modelForm.displayName.trim() || null;
      if (modelForm.editing) {
        await updateAdminModel({
          model: name,
          displayName,
          providerId: modelForm.providerId,
          enabled: modelForm.enabled,
          capabilities: modelForm.capabilities,
          modalities: modelForm.modalities,
          sortOrder: order,
          prices,
        });
      } else {
        await createAdminModel({
          model: name,
          ...(displayName ? { displayName } : {}),
          providerId: modelForm.providerId,
          enabled: modelForm.enabled,
          capabilities: modelForm.capabilities,
          modalities: modelForm.modalities,
          sortOrder: order,
          prices,
        });
      }
      setModelForm(null);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function toggleModel(row: AdminModelDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await updateAdminModel({ model: row.model, enabled: !row.enabled });
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function makeDefault(row: AdminModelDto) {
    if (inFlight.current || row.isDefault) return;
    modal.confirm({
      title: '确认设为默认模型',
      content: `确认将「${row.model}」设为全局默认模型？`,
      okText: '设为默认',
      cancelText: '取消',
      onOk: () => runMakeDefault(row),
    });
  }

  async function runMakeDefault(row: AdminModelDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await setDefaultModel(row.model);
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function removeModel(row: AdminModelDto) {
    if (inFlight.current) return;
    modal.confirm({
      title: '确认删除模型',
      content: `确认删除模型「${row.model}」？被默认模型、套餐或有效订阅引用时会被拒绝。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => runRemoveModel(row),
    });
  }

  async function runRemoveModel(row: AdminModelDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await deleteAdminModel(row.model);
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[row.model];
        return next;
      });
      await refreshAfterWrite();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function testModel(row: AdminModelDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await testAdminModel(row.model);
      setTestResults((prev) => ({ ...prev, [row.model]: result }));
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const providers = data?.providers ?? [];
  const allModels = data?.models ?? [];
  const models =
    capFilter === 'all'
      ? allModels
      : allModels.filter((m) => m.capabilities.includes(capFilter));

  const columns: TableColumnsType<AdminModelDto> = [
    {
      title: '模型',
      dataIndex: 'model',
      render: (_: unknown, m) => {
        const result = testResults[m.model];
        return (
          <div>
            <Typography.Text strong>{m.displayName}</Typography.Text>
            <div style={{ fontSize: 12, color: '#8a958f' }}>{m.model}</div>
            {result ? (
              <div style={{ marginTop: 4, fontSize: 12 }}>
                {result.ok ? (
                  <Typography.Text type="success">
                    连接正常（{result.latencyMs}ms）
                  </Typography.Text>
                ) : (
                  <Typography.Text type="danger">
                    测试失败：{result.error ?? '未知错误'}
                  </Typography.Text>
                )}
              </div>
            ) : null}
          </div>
        );
      },
    },
    { title: '厂商', dataIndex: 'providerName', width: 140, render: (v: string | null) => v ?? '未绑定' },
    {
      title: '分类',
      dataIndex: 'capabilities',
      width: 200,
      render: (v: ModelCapability[]) => (
        <Space size={4} wrap>
          {v.map((x) => (
            <Tag key={x} color={x === 'chat' ? 'green' : 'blue'}>
              {MODEL_CAPABILITY_LABELS[x]}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '模态',
      dataIndex: 'modalities',
      width: 140,
      render: (v: ModelModality[]) => v.map((x) => MODEL_MODALITY_LABELS[x]).join('、'),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (_: unknown, m) => (
        <Switch
          size="small"
          checked={m.enabled}
          disabled={busy}
          aria-label={`启用模型 ${m.model}`}
          onChange={() => void toggleModel(m)}
        />
      ),
    },
    { title: '排序', dataIndex: 'sortOrder', align: 'right', width: 80 },
    { title: '输入', dataIndex: 'inputMilliCreditsPer1k', align: 'right', width: 90 },
    { title: '输出', dataIndex: 'outputMilliCreditsPer1k', align: 'right', width: 90 },
    {
      title: '默认',
      key: 'default',
      width: 130,
      render: (_: unknown, m) =>
        m.isDefault ? (
          <Tag color="gold">★ 默认</Tag>
        ) : m.capabilities.includes('chat') ? (
          <Button size="small" disabled={busy} onClick={() => makeDefault(m)}>
            设为默认
          </Button>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            仅对话模型可设
          </Typography.Text>
        ),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 180,
      render: (v: string) => formatTime(v),
    },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      render: (_: unknown, m) => (
        <Space size={4}>
          <Button
            size="small"
            disabled={busy}
            onClick={() =>
              setModelForm({
                editing: true,
                model: m.model,
                displayName: m.displayName,
                providerId: m.providerId ?? providers[0]?.id ?? '',
                enabled: m.enabled,
                capabilities: m.capabilities,
                modalities: m.modalities,
                sortOrder: String(m.sortOrder),
                input: String(m.inputMilliCreditsPer1k),
                output: String(m.outputMilliCreditsPer1k),
              })
            }
          >
            编辑
          </Button>
          <Button
            size="small"
            disabled={busy || !m.capabilities.includes('chat')}
            title={m.capabilities.includes('chat') ? undefined : '仅对话模型支持连通性测试'}
            onClick={() => void testModel(m)}
          >
            测试
          </Button>
          <Button size="small" danger disabled={busy} onClick={() => removeModel(m)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'flex-end',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            模型配置
          </Typography.Title>
          <Typography.Text type="secondary">
            维护厂商与模型目录、启用状态、排序和价格；启用且在当前套餐内的模型会展示给客户端。
          </Typography.Text>
        </div>
        <Space wrap>
          <Select
            aria-label="按模型分类筛选"
            value={capFilter}
            disabled={busy}
            onChange={(v) => setCapFilter(v)}
            style={{ width: 150 }}
            options={[
              { value: 'all', label: '全部分类' },
              ...MODEL_CAPABILITIES.map((c) => ({
                value: c,
                label: MODEL_CAPABILITY_LABELS[c],
              })),
            ]}
          />
          <Button
            type="primary"
            disabled={busy}
            onClick={() => setProviderForm({ name: '', baseUrl: '', apiKey: '' })}
          >
            新增厂商
          </Button>
          <Button
            disabled={busy || providers.length === 0}
            onClick={() => setModelForm(emptyModelForm(providers[0]?.id ?? ''))}
          >
            新增模型
          </Button>
        </Space>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}
      {notice ? <Alert type="info" showIcon message={notice} /> : null}
      {data?.fallback.active ? (
        <Alert
          type="info"
          showIcon
          message={`当前没有在运营平台配置厂商，客户端使用环境变量兜底：${
            data.fallback.providers
              .map((p) => `${p.name}（${p.models.join('、')}）`)
              .join('；') || '无'
          }`}
        />
      ) : null}

      <Card title="厂商" extra={<Typography.Text type="secondary">{providers.length} 个</Typography.Text>}>
        {providers.length === 0 ? (
          <Typography.Text type="secondary">尚未在运营平台配置厂商。</Typography.Text>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 12,
            }}
          >
            {providers.map((p) => (
              <Card key={p.id} size="small">
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <Typography.Text strong>{p.name}</Typography.Text>
                    <Typography.Text type="secondary">{p.modelCount} 个模型</Typography.Text>
                  </div>
                  <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                    {p.baseUrl}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Key：{p.apiKeyHint ?? '未设置'}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    创建于 {formatTime(p.createdAt)}
                  </Typography.Text>
                  <Space size={4}>
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() =>
                        setProviderForm({ id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: '' })
                      }
                    >
                      编辑
                    </Button>
                    <Button
                      size="small"
                      danger
                      disabled={busy}
                      onClick={() => removeProvider(p.id, p.name)}
                    >
                      删除
                    </Button>
                  </Space>
                </Space>
              </Card>
            ))}
          </div>
        )}
      </Card>

      <Card title="模型列表" extra={<Typography.Text type="secondary">共 {models.length} 个</Typography.Text>}>
        <Table<AdminModelDto>
          rowKey="model"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={models}
          scroll={{ x: 1500 }}
          pagination={false}
          locale={{ emptyText: '暂无模型' }}
        />
      </Card>

      <Modal
        title={providerForm?.id ? '编辑厂商' : '新增厂商'}
        open={providerForm !== null}
        okText="保存"
        okButtonProps={{ disabled: busy }}
        cancelText="取消"
        onOk={() => void saveProvider()}
        onCancel={() => setProviderForm(null)}
        destroyOnHidden
      >
        {providerForm ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div>
              <Typography.Text type="secondary">厂商名称</Typography.Text>
              <Input
                style={{ marginTop: 4 }}
                value={providerForm.name}
                disabled={busy}
                placeholder="如：豆包、千问、DeepSeek"
                onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })}
              />
            </div>
            <div>
              <Typography.Text type="secondary">Base URL</Typography.Text>
              <Input
                style={{ marginTop: 4 }}
                value={providerForm.baseUrl}
                disabled={busy}
                placeholder="https://ark.cn-beijing.volces.com/api/v3"
                onChange={(e) => setProviderForm({ ...providerForm, baseUrl: e.target.value })}
              />
            </div>
            <div>
              <Typography.Text type="secondary">
                API Key{providerForm.id ? '（留空表示不修改）' : ''}
              </Typography.Text>
              <Input.Password
                style={{ marginTop: 4 }}
                autoComplete="new-password"
                value={providerForm.apiKey}
                disabled={busy}
                onChange={(e) => setProviderForm({ ...providerForm, apiKey: e.target.value })}
              />
            </div>
          </Space>
        ) : null}
      </Modal>

      <Drawer
        title={modelForm?.editing ? '编辑模型' : '新增模型'}
        width={560}
        open={modelForm !== null}
        onClose={() => setModelForm(null)}
        destroyOnHidden
        extra={
          <Space>
            <Button disabled={busy} onClick={() => setModelForm(null)}>
              取消
            </Button>
            <Button type="primary" disabled={busy} onClick={saveModel}>
              保存
            </Button>
          </Space>
        }
      >
        {modelForm ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div>
              <Typography.Text type="secondary">模型名</Typography.Text>
              <Input
                style={{ marginTop: 4 }}
                value={modelForm.model}
                disabled={busy || modelForm.editing}
                placeholder="如：doubao-pro-32k"
                onChange={(e) => setModelForm({ ...modelForm, model: e.target.value })}
              />
            </div>
            <div>
              <Typography.Text type="secondary">展示名称</Typography.Text>
              <Input
                style={{ marginTop: 4 }}
                value={modelForm.displayName}
                disabled={busy}
                placeholder="如：豆包 Pro 32K"
                onChange={(e) => setModelForm({ ...modelForm, displayName: e.target.value })}
              />
            </div>
            <div>
              <Typography.Text type="secondary">厂商</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 4 }}
                value={modelForm.providerId || undefined}
                disabled={busy}
                placeholder="选择厂商"
                onChange={(v) => setModelForm({ ...modelForm, providerId: v })}
                options={providers.map((p) => ({ value: p.id, label: p.name }))}
              />
            </div>
            <div>
              <Typography.Text type="secondary">模型分类</Typography.Text>
              <div style={{ marginTop: 4 }}>
                <Checkbox.Group
                  value={modelForm.capabilities}
                  disabled={busy}
                  onChange={(values) =>
                    setModelForm({
                      ...modelForm,
                      capabilities: MODEL_CAPABILITIES.filter((c) =>
                        (values as string[]).includes(c),
                      ),
                    })
                  }
                  options={MODEL_CAPABILITIES.map((c) => ({
                    value: c,
                    label: MODEL_CAPABILITY_LABELS[c],
                  }))}
                />
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                只有包含「对话」的模型会出现在客户端模型选择器；Embedding 用于知识库向量化，Rerank
                用于检索重排，TTS/ASR 用于语音。
              </Typography.Text>
            </div>
            <div>
              <Typography.Text type="secondary">模态</Typography.Text>
              <div style={{ marginTop: 4 }}>
                <Checkbox.Group
                  value={modelForm.modalities}
                  disabled={busy}
                  onChange={(values) =>
                    setModelForm({
                      ...modelForm,
                      modalities: MODEL_MODALITIES.filter((m) =>
                        (values as string[]).includes(m),
                      ),
                    })
                  }
                  options={MODEL_MODALITIES.map((m) => ({
                    value: m,
                    label: MODEL_MODALITY_LABELS[m],
                  }))}
                />
              </div>
            </div>
            <div>
              <Typography.Text type="secondary">排序</Typography.Text>
              <InputNumber
                style={{ width: '100%', marginTop: 4 }}
                min={0}
                max={1_000_000}
                precision={0}
                value={modelForm.sortOrder === '' ? null : Number(modelForm.sortOrder)}
                disabled={busy}
                onChange={(v) => setModelForm({ ...modelForm, sortOrder: numberText(v) })}
              />
            </div>
            <div>
              <Typography.Text type="secondary">输入（毫积分/1K）</Typography.Text>
              <InputNumber
                style={{ width: '100%', marginTop: 4 }}
                min={0}
                max={MAX_MILLI_CREDITS}
                precision={0}
                value={modelForm.input === '' ? null : Number(modelForm.input)}
                disabled={busy}
                onChange={(v) => setModelForm({ ...modelForm, input: numberText(v) })}
              />
            </div>
            <div>
              <Typography.Text type="secondary">输出（毫积分/1K）</Typography.Text>
              <InputNumber
                style={{ width: '100%', marginTop: 4 }}
                min={0}
                max={MAX_MILLI_CREDITS}
                precision={0}
                value={modelForm.output === '' ? null : Number(modelForm.output)}
                disabled={busy}
                onChange={(v) => setModelForm({ ...modelForm, output: numberText(v) })}
              />
            </div>
            <Space size={8}>
              <Typography.Text type="secondary">启用</Typography.Text>
              <Switch
                checked={modelForm.enabled}
                disabled={busy}
                onChange={(checked) => setModelForm({ ...modelForm, enabled: checked })}
              />
            </Space>
          </Space>
        ) : null}
      </Drawer>
    </Space>
  );
}
