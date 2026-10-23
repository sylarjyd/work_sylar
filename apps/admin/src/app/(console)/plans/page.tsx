'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  App,
  Button,
  Card,
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
  MODEL_MODALITY_LABELS,
  type AdminModelDto,
  type AdminPlanDto,
  type AdminPlanInput,
  type AdminPlanPatch,
} from '@ai-office/shared';
import {
  adminErrorText,
  createAdminPlan,
  deleteAdminPlan,
  getAdminModels,
  isForbidden,
  listAdminPlans,
  updateAdminPlan,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

const EMPTY: AdminPlanInput = {
  id: '',
  name: '',
  priceCents: 0,
  monthlyBaseCredits: 0,
  monthlyBonusCredits: 0,
  maxCreditsPerRun: 0,
  rpm: 0,
  allowedModels: [],
  active: true,
};

function numberOrZero(v: number | null): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export default function AdminPlansPage() {
  const router = useRouter();
  const { modal, message } = App.useApp();
  const [plans, setPlans] = useState<AdminPlanDto[]>([]);
  const [form, setForm] = useState<AdminPlanInput>(EMPTY);
  const [catalog, setCatalog] = useState<AdminModelDto[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  // 删除是危险操作：选中后必须手动输入套餐标识才能提交。
  const [deleting, setDeleting] = useState<AdminPlanDto | null>(null);
  const [confirmId, setConfirmId] = useState('');

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
      const rows = await listAdminPlans();
      // 过期响应不写状态
      if (id !== loadSeq.current) return true;
      setPlans(rows);
      return true;
    } catch (err) {
      if (id !== loadSeq.current) return true;
      return !handleErr(err);
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [handleErr]);

  // 写操作结束后必须调用最新的 load，避免用旧的筛选闭包覆盖用户刚改的条件
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  // 模型目录用于勾选允许模型；停用模型仍展示，避免历史套餐丢失引用。
  useEffect(() => {
    let cancelled = false;
    getAdminModels()
      .then((data) => {
        if (!cancelled) setCatalog(data.models);
      })
      .catch((err) => {
        if (!cancelled) setCatalogError(adminErrorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  function startEdit(plan: AdminPlanDto) {
    setEditing(plan.id);
    setForm({
      id: plan.id,
      name: plan.name,
      priceCents: plan.priceCents,
      monthlyBaseCredits: plan.monthlyBaseCredits,
      monthlyBonusCredits: plan.monthlyBonusCredits,
      maxCreditsPerRun: plan.maxCreditsPerRun,
      rpm: plan.rpm,
      allowedModels: plan.allowedModels,
      active: plan.active,
    });
  }

  function resetForm() {
    setEditing(null);
    setForm(EMPTY);
  }

  function save() {
    if (inFlight.current || busy) return;
    const payload: AdminPlanInput = {
      ...form,
      allowedModels: form.allowedModels,
    };
    if (!payload.name.trim()) {
      setError('套餐名称不能为空');
      return;
    }
    if (payload.allowedModels.length === 0) {
      setError('请至少选择一个允许模型');
      return;
    }
    const verb = editing ? '保存修改' : '创建套餐';
    modal.confirm({
      title: `确认${verb}`,
      content: `确认${verb}「${payload.name}」？`,
      okText: verb,
      cancelText: '取消',
      onOk: () => runSave(payload),
    });
  }

  async function runSave(payload: AdminPlanInput) {
    if (inFlight.current) return;
    setError('');
    setNotice('');
    inFlight.current = true;
    setBusy(true);
    try {
      if (editing) {
        // 标识是主键，更新时不可变。
        const patch: AdminPlanPatch = {
          name: payload.name,
          priceCents: payload.priceCents,
          monthlyBaseCredits: payload.monthlyBaseCredits,
          monthlyBonusCredits: payload.monthlyBonusCredits,
          maxCreditsPerRun: payload.maxCreditsPerRun,
          rpm: payload.rpm,
          allowedModels: payload.allowedModels,
          active: payload.active,
        };
        await updateAdminPlan(editing, patch);
      } else {
        await createAdminPlan(payload);
      }
      resetForm();
      // 写操作已成功，先给出明确提示，避免补刷新失败被误判为写失败而重复提交
      setNotice('操作已成功，正在刷新数据…');
      const ok = await loadRef.current();
      setNotice(ok ? '操作已成功。' : '操作已成功，但数据刷新失败，请勿重复提交；稍后可刷新页面确认。');
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function startDelete(plan: AdminPlanDto) {
    setDeleting(plan);
    setConfirmId('');
    setError('');
    setNotice('');
  }

  function cancelDelete() {
    setDeleting(null);
    setConfirmId('');
  }

  async function confirmDelete() {
    if (!deleting || inFlight.current) return;
    if (confirmId.trim() !== deleting.id) {
      setError('请输入完整且一致的套餐标识后再删除');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await deleteAdminPlan(deleting.id, { confirmId: confirmId.trim() });
      // 表单若正编辑该套餐，需重置，避免后续保存时对已删除的主键发更新。
      if (editing === deleting.id) resetForm();
      setDeleting(null);
      setConfirmId('');
      setNotice('操作已成功，正在刷新数据…');
      const ok = await loadRef.current();
      setNotice(ok ? '操作已成功。' : '操作已成功，但数据刷新失败，请勿重复提交；稍后可刷新页面确认。');
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function deactivate(plan: AdminPlanDto) {
    if (inFlight.current) return;
    modal.confirm({
      title: '确认停用套餐',
      content: `确认停用套餐「${plan.name}」？停用后新用户不可再订阅。`,
      okText: '停用',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => runDeactivate(plan),
    });
  }

  async function runDeactivate(plan: AdminPlanDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await updateAdminPlan(plan.id, { active: false });
      // 表单若正编辑该套餐，需重置，避免残留的 active: true 在后续保存时把套餐重新启用
      if (editing === plan.id) resetForm();
      if (deleting?.id === plan.id) cancelDelete();
      setNotice('操作已成功，正在刷新数据…');
      const ok = await loadRef.current();
      setNotice(ok ? '操作已成功。' : '操作已成功，但数据刷新失败，请勿重复提交；稍后可刷新页面确认。');
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // 目录里没有的历史模型也要展示，避免编辑旧套餐时引用被悄悄丢弃。
  const modelOptions = [
    ...catalog,
    ...form.allowedModels
      .filter((m) => !catalog.some((c) => c.model === m))
      .map((model) => ({
        model,
        displayName: model,
        enabled: false,
        providerName: null,
        modalities: [] as AdminModelDto['modalities'],
      })),
  ].map((m) => ({
    value: m.model,
    label: `${m.displayName || m.model}${
      m.modalities.length > 0
        ? `（${m.modalities.map((x) => MODEL_MODALITY_LABELS[x]).join('、')}）`
        : ''
    }${!m.enabled ? '（已停用）' : ''}`,
  }));

  const columns: TableColumnsType<AdminPlanDto> = [
    { title: '标识', dataIndex: 'id', width: 120 },
    {
      title: '名称',
      dataIndex: 'name',
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
    },
    { title: '价格（分）', dataIndex: 'priceCents', align: 'right', width: 120 },
    {
      title: '额度',
      key: 'credits',
      align: 'right',
      width: 110,
      render: (_: unknown, p) => p.monthlyBaseCredits + p.monthlyBonusCredits,
    },
    { title: '单次上限', dataIndex: 'maxCreditsPerRun', align: 'right', width: 110 },
    { title: 'RPM', dataIndex: 'rpm', align: 'right', width: 90 },
    {
      title: '模型',
      dataIndex: 'allowedModels',
      ellipsis: true,
      render: (v: string[]) => v.join('、'),
    },
    {
      title: '状态',
      dataIndex: 'active',
      width: 90,
      render: (v: boolean) =>
        v ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 190,
      render: (_: unknown, p) => (
        <Space size={4}>
          <Button size="small" disabled={busy} onClick={() => startEdit(p)}>
            编辑
          </Button>
          <Button
            size="small"
            disabled={busy || p.id === 'free' || !p.active}
            onClick={() => deactivate(p)}
          >
            停用
          </Button>
          <Button
            size="small"
            danger
            disabled={busy || p.id === 'free'}
            title={p.id === 'free' ? '免费套餐是注册默认套餐，不能删除' : undefined}
            onClick={() => startDelete(p)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          套餐目录
        </Typography.Title>
        <Typography.Text type="secondary">
          停用用于暂时下线；删除不可恢复，需手动输入套餐标识确认。免费套餐不可停用或删除。
        </Typography.Text>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}
      {notice ? <Alert type="info" showIcon message={notice} /> : null}

      <Card title={editing ? `编辑套餐 ${editing}` : '新建套餐'}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 12,
            }}
          >
            <label>
              <Typography.Text type="secondary">标识（slug）</Typography.Text>
              <Input
                style={{ marginTop: 4 }}
                value={form.id}
                disabled={!!editing || busy}
                onChange={(e) => setForm({ ...form, id: e.target.value })}
              />
            </label>
            <label>
              <Typography.Text type="secondary">名称</Typography.Text>
              <Input
                style={{ marginTop: 4 }}
                value={form.name}
                disabled={busy}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              <Typography.Text type="secondary">价格（分/月）</Typography.Text>
              <InputNumber
                style={{ marginTop: 4, width: '100%' }}
                min={0}
                precision={0}
                value={form.priceCents}
                disabled={busy}
                onChange={(v) => setForm({ ...form, priceCents: numberOrZero(v) })}
              />
            </label>
            <label>
              <Typography.Text type="secondary">月度基础积分</Typography.Text>
              <InputNumber
                style={{ marginTop: 4, width: '100%' }}
                min={0}
                precision={0}
                value={form.monthlyBaseCredits}
                disabled={busy}
                onChange={(v) => setForm({ ...form, monthlyBaseCredits: numberOrZero(v) })}
              />
            </label>
            <label>
              <Typography.Text type="secondary">月度赠送积分</Typography.Text>
              <InputNumber
                style={{ marginTop: 4, width: '100%' }}
                min={0}
                precision={0}
                value={form.monthlyBonusCredits}
                disabled={busy}
                onChange={(v) => setForm({ ...form, monthlyBonusCredits: numberOrZero(v) })}
              />
            </label>
            <label>
              <Typography.Text type="secondary">单次上限</Typography.Text>
              <InputNumber
                style={{ marginTop: 4, width: '100%' }}
                min={0}
                precision={0}
                value={form.maxCreditsPerRun}
                disabled={busy}
                onChange={(v) => setForm({ ...form, maxCreditsPerRun: numberOrZero(v) })}
              />
            </label>
            <label>
              <Typography.Text type="secondary">RPM</Typography.Text>
              <InputNumber
                style={{ marginTop: 4, width: '100%' }}
                min={0}
                precision={0}
                value={form.rpm}
                disabled={busy}
                onChange={(v) => setForm({ ...form, rpm: numberOrZero(v) })}
              />
            </label>
          </div>

          <div>
            <Typography.Text type="secondary">允许模型</Typography.Text>
            {catalogError ? (
              <div style={{ marginTop: 4 }}>
                <Typography.Text type="danger">{catalogError}</Typography.Text>
              </div>
            ) : null}
            <Select
              mode="multiple"
              style={{ width: '100%', marginTop: 4 }}
              placeholder="选择套餐可用的模型"
              value={form.allowedModels}
              options={modelOptions}
              disabled={busy}
              onChange={(values: string[]) => setForm({ ...form, allowedModels: values })}
            />
          </div>

          <Space>
            <Space size={8}>
              <Typography.Text type="secondary">启用</Typography.Text>
              <Switch
                checked={form.active}
                disabled={busy}
                onChange={(checked) => setForm({ ...form, active: checked })}
              />
            </Space>
            <Button type="primary" disabled={busy} onClick={save}>
              {editing ? '保存' : '创建'}
            </Button>
            {editing ? (
              <Button disabled={busy} onClick={resetForm}>
                取消
              </Button>
            ) : null}
          </Space>
        </Space>
      </Card>

      <Card title="套餐列表" extra={<Typography.Text type="secondary">共 {plans.length} 个</Typography.Text>}>
        <Table<AdminPlanDto>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={plans}
          scroll={{ x: 1200 }}
          pagination={false}
          locale={{ emptyText: '暂无套餐' }}
        />
      </Card>

      <Modal
        title={deleting ? `删除套餐 ${deleting.name}（${deleting.id}）` : '删除套餐'}
        open={deleting !== null}
        okText="确认删除"
        okButtonProps={{
          danger: true,
          disabled: busy || confirmId.trim() !== (deleting?.id ?? ''),
        }}
        cancelText="取消"
        onOk={() => void confirmDelete()}
        onCancel={cancelDelete}
        destroyOnHidden
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text>
            删除后不可恢复，且该套餐下不能存在租户订阅。请输入套餐标识{' '}
            <Typography.Text strong>{deleting?.id}</Typography.Text> 以确认。
          </Typography.Text>
          <Input
            value={confirmId}
            placeholder={deleting?.id}
            disabled={busy}
            autoFocus
            onChange={(e) => setConfirmId(e.target.value)}
            onPressEnter={() => {
              if (confirmId.trim() === deleting?.id) {
                void confirmDelete();
              } else {
                void message.error('请输入完整且一致的套餐标识后再删除');
              }
            }}
          />
        </Space>
      </Modal>
    </Space>
  );
}
