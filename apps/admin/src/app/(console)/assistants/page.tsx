'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Input,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import {
  ASSISTANT_PERMISSION_MODES,
  ASSISTANT_PERMISSION_MODE_LABELS,
  ASSISTANT_SKILLS,
  type AdminAssistantDto,
  type AssistantPermissionMode,
  type SkillDto,
} from '@ai-office/shared';
import {
  adminErrorText,
  createAdminAssistant,
  deleteAdminAssistant,
  isForbidden,
  listAdminAssistants,
  listAdminSkills,
  updateAdminAssistant,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';

const PAGE_SIZE = 20;

const PERMISSION_LABELS: Record<string, string> = {
  standard: '标准',
  readonly: '只读',
  auto: '自动',
};

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

interface AssistantForm {
  name: string;
  description: string;
  systemPrompt: string;
  permissionMode: AssistantPermissionMode;
  skills: string[];
  skillIds: string[];
}

const EMPTY_FORM: AssistantForm = {
  name: '',
  description: '',
  systemPrompt: '',
  permissionMode: 'standard',
  skills: ASSISTANT_SKILLS.map((s) => s.key),
  skillIds: [],
};

/** 运营端专家助手列表：公共内置助手与用户自定义助手只读展示。 */
export default function AdminAssistantsPage() {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [items, setItems] = useState<AdminAssistantDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState<'all' | 'public' | 'personal'>('all');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<AdminAssistantDto | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AssistantForm>(EMPTY_FORM);
  const [publicSkills, setPublicSkills] = useState<SkillDto[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadSeq = useRef(0);

  const handleErr = useCallback(
    (err: unknown): void => {
      if (isUnauthorized(err)) {
        router.replace('/login');
        return;
      }
      if (isForbidden(err)) {
        clearToken();
        router.replace('/login');
        return;
      }
      setError(adminErrorText(err));
    },
    [router],
  );

  const load = useCallback(async (): Promise<void> => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await listAdminAssistants({
        page,
        pageSize: PAGE_SIZE,
        ...(scope === 'all' ? {} : { scope }),
        ...(q.trim() ? { q: q.trim() } : {}),
      });
      if (id !== loadSeq.current) return;
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      if (id !== loadSeq.current) return;
      handleErr(err);
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [page, scope, q, handleErr]);

  useEffect(() => {
    void load();
  }, [load]);

  // 公共助手只能绑定公共技能，这里只拉公共技能做选项。
  useEffect(() => {
    void listAdminSkills({ page: 1, pageSize: 100, scope: 'public' })
      .then((data) => setPublicSkills(data.items))
      .catch(() => undefined);
  }, []);

  function openCreate(): void {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  function openEdit(item: AdminAssistantDto): void {
    setEditingId(item.id);
    setForm({
      name: item.name,
      description: item.description,
      systemPrompt: item.systemPrompt,
      permissionMode: item.permissionMode,
      skills: item.skills,
      skillIds: item.skillIds,
    });
    setFormOpen(true);
  }

  async function save(): Promise<void> {
    if (saving) return;
    if (!form.name.trim()) {
      void message.error('助手名称不能为空');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim(),
        systemPrompt: form.systemPrompt,
        permissionMode: form.permissionMode,
        skills: form.skills,
        skillIds: form.skillIds,
      };
      if (editingId) await updateAdminAssistant(editingId, payload);
      else await createAdminAssistant(payload);
      setFormOpen(false);
      await load();
      void message.success('已保存');
    } catch (err) {
      handleErr(err);
    } finally {
      setSaving(false);
    }
  }

  function removeAssistant(item: AdminAssistantDto): void {
    modal.confirm({
      title: '确认删除专家助手',
      content: `确认删除「${item.name}」？已创建的历史会话会退化为默认助手。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteAdminAssistant(item.id);
          await load();
          void message.success('已删除');
        } catch (err) {
          handleErr(err);
        }
      },
    });
  }

  const columns: TableColumnsType<AdminAssistantDto> = [
    {
      title: '助手',
      dataIndex: 'name',
      width: 240,
      render: (_: unknown, item) => (
        <div style={{ minWidth: 0 }}>
          <Typography.Text strong ellipsis={{ tooltip: item.name }}>
            {item.name}
          </Typography.Text>
          {item.description ? (
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, display: 'block' }}
              ellipsis={{ tooltip: item.description }}
            >
              {item.description}
            </Typography.Text>
          ) : null}
        </div>
      ),
    },
    {
      title: '范围',
      dataIndex: 'scope',
      width: 100,
      render: (_: unknown, item) =>
        item.scope === 'public' ? <Tag color="green">公共内置</Tag> : <Tag>个人</Tag>,
    },
    {
      title: '创建者',
      dataIndex: 'ownerEmail',
      width: 200,
      ellipsis: true,
      render: (value: string | null) => value ?? '-',
    },
    {
      title: '绑定技能',
      dataIndex: 'skillNames',
      width: 240,
      render: (_: unknown, item) =>
        item.skillNames.length > 0 ? (
          <Space size={4} wrap>
            {item.skillNames.slice(0, 3).map((name) => (
              <Tag key={name}>{name}</Tag>
            ))}
            {item.skillNames.length > 3 ? <Tag>+{item.skillNames.length - 3}</Tag> : null}
          </Space>
        ) : (
          <Typography.Text type="secondary">未绑定</Typography.Text>
        ),
    },
    {
      title: '工具',
      dataIndex: 'skills',
      width: 180,
      render: (_: unknown, item) =>
        item.skills.length > 0 ? item.skills.join(' / ') : '无限制',
    },
    {
      title: '模型',
      dataIndex: 'model',
      width: 150,
      ellipsis: true,
      render: (value: string | null) => value ?? '默认',
    },
    {
      title: '权限',
      dataIndex: 'permissionMode',
      width: 90,
      render: (value: string) => PERMISSION_LABELS[value] ?? value,
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 170,
      render: (value: string) => formatTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_: unknown, item) => (
        <Space size={4}>
          <Button size="small" onClick={() => setDetail(item)}>
            详情
          </Button>
          {item.scope === 'public' ? (
            <>
              <Button size="small" onClick={() => openEdit(item)}>
                编辑
              </Button>
              <Button size="small" danger onClick={() => removeAssistant(item)}>
                删除
              </Button>
            </>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          专家助手
        </Typography.Title>
        <Typography.Text type="secondary">
          公共内置助手对所有用户可见并可直接使用；个人助手只有创建者可见，运营端只读排查。
        </Typography.Text>
      </div>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Card
        title="专家助手列表"
        extra={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建专家助手
            </Button>
            <Segmented
              value={scope}
              onChange={(value) => {
                setPage(1);
                setScope(value as 'all' | 'public' | 'personal');
              }}
              options={[
                { value: 'all', label: '全部' },
                { value: 'public', label: '公共内置' },
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
          </Space>
        }
      >
        <Table<AdminAssistantDto>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={items}
          scroll={{ x: 1500 }}
          locale={{ emptyText: '暂无助手' }}
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
        open={formOpen}
        title={editingId ? '编辑专家助手' : '新建专家助手'}
        width={760}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void save()}
        onCancel={() => {
          if (!saving) setFormOpen(false);
        }}
        styles={{ body: { maxHeight: '68vh', overflowY: 'auto' } }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary">名称</Typography.Text>
            <Input
              style={{ marginTop: 4 }}
              maxLength={40}
              value={form.name}
              placeholder="如：合同审阅专家"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <Typography.Text type="secondary">简介</Typography.Text>
            <Input.TextArea
              style={{ marginTop: 4 }}
              rows={2}
              maxLength={200}
              showCount
              value={form.description}
              placeholder="一句话说明这个专家助手擅长什么"
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div>
            <Typography.Text type="secondary">系统提示词</Typography.Text>
            <Input.TextArea
              style={{ marginTop: 4 }}
              rows={6}
              maxLength={8000}
              showCount
              value={form.systemPrompt}
              placeholder="描述角色、目标、工作方式与输出要求"
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            />
          </div>
          <Row gutter={12}>
            <Col span={12}>
              <Typography.Text type="secondary">权限模式</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 4 }}
                value={form.permissionMode}
                onChange={(value: AssistantPermissionMode) =>
                  setForm({ ...form, permissionMode: value })
                }
                options={ASSISTANT_PERMISSION_MODES.map((mode) => ({
                  value: mode,
                  label: ASSISTANT_PERMISSION_MODE_LABELS[mode],
                }))}
              />
            </Col>
            <Col span={12}>
              <Typography.Text type="secondary">绑定公共技能</Typography.Text>
              <Select
                mode="multiple"
                style={{ width: '100%', marginTop: 4 }}
                allowClear
                value={form.skillIds}
                placeholder={publicSkills.length === 0 ? '技能市场暂无公共技能' : '选择要绑定的公共技能'}
                onChange={(value: string[]) => setForm({ ...form, skillIds: value })}
                options={publicSkills.map((s) => ({ value: s.id, label: s.name }))}
                optionFilterProp="label"
              />
            </Col>
          </Row>
          <div>
            <Typography.Text type="secondary">工具</Typography.Text>
            <div className="assistant-tool-grid">
              {ASSISTANT_SKILLS.map((tool) => (
                <Checkbox
                  key={tool.key}
                  checked={form.skills.includes(tool.key)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      skills: e.target.checked
                        ? [...form.skills, tool.key]
                        : form.skills.filter((x) => x !== tool.key),
                    })
                  }
                >
                  <span className="assistant-tool-name">{tool.name}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {tool.description}
                  </Typography.Text>
                </Checkbox>
              ))}
            </div>
          </div>
        </Space>
      </Modal>

      <Modal
        open={detail !== null}
        title={`助手详情 · ${detail?.name ?? ''}`}
        footer={null}
        width={720}
        onCancel={() => setDetail(null)}
      >
        {detail ? (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="范围">
              {detail.scope === 'public' ? '公共内置（所有用户可用）' : '个人（仅创建者）'}
            </Descriptions.Item>
            <Descriptions.Item label="创建者">{detail.ownerEmail ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="简介">{detail.description || '-'}</Descriptions.Item>
            <Descriptions.Item label="绑定技能">
              {detail.skillNames.length > 0 ? detail.skillNames.join('、') : '未绑定'}
            </Descriptions.Item>
            <Descriptions.Item label="工具">
              {detail.skills.length > 0 ? detail.skills.join(' / ') : '无限制'}
            </Descriptions.Item>
            <Descriptions.Item label="知识库">
              {detail.kbIds.length > 0 ? `${detail.kbIds.length} 个` : '全部知识库'}
            </Descriptions.Item>
            <Descriptions.Item label="默认模型">{detail.model ?? '默认'}</Descriptions.Item>
            <Descriptions.Item label="系统提示词">
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {detail.systemPrompt || '（空）'}
              </Typography.Paragraph>
            </Descriptions.Item>
          </Descriptions>
        ) : null}
      </Modal>
    </Space>
  );
}
