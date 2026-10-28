'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  App,
  Button,
  Card,
  Input,
  Modal,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import type { SkillDto, SkillInput } from '@ai-office/shared';
import {
  adminErrorText,
  createAdminSkill,
  deleteAdminSkill,
  isForbidden,
  listAdminSkills,
  setAdminSkillEnabled,
  updateAdminSkill,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

const PAGE_SIZE = 20;

interface SkillForm extends SkillInput {
  id?: string;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/** 运营端技能管理：公共技能可维护，个人技能只读展示（用户私域）。 */
export default function AdminSkillsPage() {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [items, setItems] = useState<SkillDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState<'all' | 'public' | 'personal'>('all');
  const [q, setQ] = useState('');
  const [form, setForm] = useState<SkillForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
      const data = await listAdminSkills({
        page,
        pageSize: PAGE_SIZE,
        ...(scope === 'all' ? {} : { scope }),
        ...(q.trim() ? { q: q.trim() } : {}),
      });
      if (id !== loadSeq.current) return true;
      setItems(data.items);
      setTotal(data.total);
      return true;
    } catch (err) {
      if (id !== loadSeq.current) return true;
      return !handleErr(err);
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [page, scope, q, handleErr]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!form || inFlight.current) return;
    if (!form.name.trim() || !form.content.trim()) {
      void message.error('技能名称与内容不能为空');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const input: SkillInput = {
        name: form.name.trim(),
        description: form.description?.trim() ?? '',
        content: form.content.trim(),
      };
      if (form.id) await updateAdminSkill(form.id, input);
      else await createAdminSkill(input);
      setForm(null);
      await loadRef.current();
      void message.success('已保存');
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function toggleEnabled(item: SkillDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await setAdminSkillEnabled(item.id, !item.enabled);
      await loadRef.current();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function remove(item: SkillDto) {
    if (inFlight.current) return;
    modal.confirm({
      title: '确认删除技能',
      content: `确认删除公共技能「${item.name}」？已绑定该技能的助手将不再注入其内容。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        try {
          await deleteAdminSkill(item.id);
          // 删掉当前页最后一条时回退一页，避免停在空页。
          if (items.length === 1 && page > 1) setPage(page - 1);
          else await loadRef.current();
        } catch (err) {
          handleErr(err);
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      },
    });
  }

  const columns: TableColumnsType<SkillDto> = [
    {
      title: '技能',
      dataIndex: 'name',
      width: 260,
      render: (_: unknown, item) => (
        <div>
          <Typography.Text strong>{item.name}</Typography.Text>
          {item.description ? (
            <div style={{ fontSize: 12, color: '#8a958f' }}>{item.description}</div>
          ) : null}
        </div>
      ),
    },
    {
      title: '范围',
      dataIndex: 'scope',
      width: 130,
      render: (_: unknown, item) =>
        item.scope === 'public' ? (
          <Tag color="green">公共技能</Tag>
        ) : (
          <Tag>个人技能</Tag>
        ),
    },
    {
      title: '归属',
      dataIndex: 'ownerEmail',
      width: 220,
      ellipsis: true,
      render: (_: unknown, item) =>
        item.scope === 'public' ? (
          item.ownerEmail ? `共享自 ${item.ownerEmail}` : '运营创建'
        ) : (
          (item.ownerEmail ?? '-')
        ),
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 110,
      render: (_: unknown, item) => (item.source === 'run' ? '任务总结' : '手工创建'),
    },
    {
      title: '内容',
      dataIndex: 'content',
      ellipsis: true,
      render: (_: unknown, item) => (
        <Typography.Text type="secondary">{item.content.slice(0, 80)}</Typography.Text>
      ),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 90,
      render: (_: unknown, item) =>
        item.enabled ? <Tag color="success">启用</Tag> : <Tag>已停用</Tag>,
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 180,
      render: (value: string) => formatTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_: unknown, item) =>
        item.scope === 'public' ? (
          <Space size={4}>
            <Button
              size="small"
              disabled={busy}
              onClick={() =>
                setForm({
                  id: item.id,
                  name: item.name,
                  description: item.description,
                  content: item.content,
                })
              }
            >
              编辑
            </Button>
            <Button size="small" disabled={busy} onClick={() => void toggleEnabled(item)}>
              {item.enabled ? '停用' : '启用'}
            </Button>
            <Button size="small" danger disabled={busy} onClick={() => remove(item)}>
              删除
            </Button>
          </Space>
        ) : (
          <Typography.Text type="secondary">用户私域，只读</Typography.Text>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          技能管理
        </Typography.Title>
        <Typography.Text type="secondary">
          公共技能所有用户可见并可在助手中绑定；用户创建的个人技能仅本人可见，共享后转为公共。
        </Typography.Text>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Card
        title="技能列表"
        extra={
          <Space wrap>
            <Segmented
              value={scope}
              onChange={(value) => {
                setPage(1);
                setScope(value as 'all' | 'public' | 'personal');
              }}
              options={[
                { value: 'all', label: '全部' },
                { value: 'public', label: '公共' },
                { value: 'personal', label: '个人' },
              ]}
            />
            <Input.Search
              allowClear
              placeholder="按名称/简介搜索"
              style={{ width: 220 }}
              onSearch={(value) => {
                setPage(1);
                setQ(value);
              }}
            />
            <Button
              type="primary"
              disabled={busy}
              onClick={() => setForm({ name: '', description: '', content: '' })}
            >
              新建公共技能
            </Button>
          </Space>
        }
      >
        <Table<SkillDto>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 1300 }}
          locale={{ emptyText: '暂无技能' }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 条`,
            onChange: setPage,
          }}
        />
      </Card>

      <Modal
        title={form?.id ? '编辑公共技能' : '新建公共技能'}
        open={form !== null}
        okText="保存"
        cancelText="取消"
        confirmLoading={busy}
        onOk={() => void save()}
        onCancel={() => {
          if (!busy) setForm(null);
        }}
        width={640}
      >
        {form ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div>
              <Typography.Text type="secondary">技能名称</Typography.Text>
              <Input
                style={{ marginTop: 4 }}
                maxLength={40}
                value={form.name}
                disabled={busy}
                placeholder="如：周报撰写规范"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div>
              <Typography.Text type="secondary">一句话简介</Typography.Text>
              <Input
                style={{ marginTop: 4 }}
                maxLength={200}
                value={form.description ?? ''}
                disabled={busy}
                placeholder="技能市场列表里展示"
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div>
              <Typography.Text type="secondary">
                技能内容（会拼进系统提示词，写清适用场景、步骤与注意事项）
              </Typography.Text>
              <Input.TextArea
                style={{ marginTop: 4 }}
                rows={10}
                maxLength={4000}
                showCount
                value={form.content}
                disabled={busy}
                placeholder={'适用场景：……\n步骤：1) … 2) …\n注意：……'}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
              />
            </div>
          </Space>
        ) : null}
      </Modal>
    </Space>
  );
}
