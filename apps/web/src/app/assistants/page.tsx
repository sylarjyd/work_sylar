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
  Empty,
  Input,
  List,
  Row,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import {
  ASSISTANT_PERMISSION_MODES,
  ASSISTANT_PERMISSION_MODE_HINTS,
  ASSISTANT_PERMISSION_MODE_LABELS,
  ASSISTANT_SKILLS,
  type AssistantDto,
  type AssistantInput,
  type AssistantPermissionMode,
  type ClientModelDto,
  type KbBaseDto,
  type SkillDto,
} from '@ai-office/shared';
import { AppShell } from '../../components/app-shell';
import {
  createAssistant,
  deleteAssistant,
  getToken,
  isUnauthorized,
  listAssistants,
  listKbBases,
  listModels,
  listSkills,
  updateAssistant,
} from '../../lib/api';
import { errorText } from '@ai-office/web-core';

interface FormState {
  name: string;
  description: string;
  systemPrompt: string;
  permissionMode: AssistantPermissionMode;
  model: string;
  skills: string[];
  /** 绑定的技能市场技能（公共或自己的个人技能）。 */
  skillIds: string[];
  kbIds: string[];
}

const EMPTY: FormState = {
  name: '',
  description: '',
  systemPrompt: '',
  permissionMode: 'standard',
  model: '',
  skills: ASSISTANT_SKILLS.map((s) => s.key),
  skillIds: [],
  kbIds: [],
};

export default function AssistantsPage() {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [assistants, setAssistants] = useState<AssistantDto[]>([]);
  const [models, setModels] = useState<ClientModelDto[]>([]);
  const [bases, setBases] = useState<KbBaseDto[]>([]);
  // 可绑定的技能：公共技能 + 自己的个人技能（接口已按可见性过滤）。
  const [skillCatalog, setSkillCatalog] = useState<SkillDto[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  const handleErr = useCallback(
    (err: unknown) => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return;
      }
      setError(errorText(err));
    },
    [router],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, modelData, kbBases, skills] = await Promise.all([
        listAssistants(),
        listModels(),
        listKbBases(),
        listSkills(),
      ]);
      setAssistants(rows);
      setModels(modelData.models);
      setBases(kbBases);
      setSkillCatalog(skills.items);
    } catch (err) {
      handleErr(err);
    } finally {
      setLoading(false);
    }
  }, [handleErr]);

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    void refresh();
  }, [refresh, router]);

  function resetForm() {
    setEditing(null);
    setForm(EMPTY);
    setError('');
  }

  function startEdit(a: AssistantDto) {
    setEditing(a.id);
    setForm({
      name: a.name,
      description: a.description,
      systemPrompt: a.systemPrompt,
      permissionMode: a.permissionMode,
      model: a.model ?? '',
      skills: a.skills,
      // 已下架/已删除的技能不保留绑定，避免保存时被服务端整单拒绝。
      skillIds: a.skillIds.filter((id) => skillCatalog.some((s) => s.id === id)),
      // 服务端可能返回已删除知识库的残留 id：只保留当前仍存在的库，避免无意义绑定。
      kbIds: a.kbIds.filter((id) => bases.some((b) => b.id === id)),
    });
    setError('');
  }

  function save() {
    if (inFlight.current) return;
    setError('');
    const name = form.name.trim();
    if (!name) {
      setError('助手名称不能为空');
      return;
    }
    const payload: AssistantInput = {
      name,
      description: form.description,
      systemPrompt: form.systemPrompt,
      permissionMode: form.permissionMode,
      model: form.model || null,
      skills: form.skills,
      skillIds: form.skillIds,
      kbIds: form.kbIds,
    };
    const verb = editing ? '保存修改' : '创建助手';
    modal.confirm({
      title: verb,
      content: `确认${verb}「${name}」？`,
      okText: verb,
      cancelText: '取消',
      onOk: () => runSave(payload),
    });
  }

  async function runSave(payload: AssistantInput) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      if (editing) await updateAssistant(editing, payload);
      else await createAssistant(payload);
      resetForm();
      message.success('已保存');
      await refresh();
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function remove(a: AssistantDto) {
    if (inFlight.current) return;
    modal.confirm({
      title: '删除助手',
      content: `确认删除助手「${a.name}」？已创建的历史任务会退化为默认助手。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => runRemove(a),
    });
  }

  async function runRemove(a: AssistantDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await deleteAssistant(a.id);
      if (editing === a.id) resetForm();
      setAssistants((prev) => prev.filter((x) => x.id !== a.id));
      message.success(`已删除「${a.name}」`);
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const skillLabels = (keys: string[]): string =>
    ASSISTANT_SKILLS.filter((s) => keys.includes(s.key))
      .map((s) => s.name)
      .join('、') || '未绑定技能';

  const kbSummary = (ids: string[]): string => {
    if (ids.length === 0) return '全部知识库';
    const names = ids.map((id) => bases.find((b) => b.id === id)?.name ?? '已删除的知识库');
    return names.length <= 3 ? names.join('、') : `${names.slice(0, 3).join('、')} 等 ${names.length} 个`;
  };

  return (
    <AppShell active="assistants">
      <div className="page-scroll">
        <div className="page">
          <header className="page-head">
            <div>
              <h1 className="page-title">我的助手</h1>
              <p className="page-sub">
                创建专属助手：设定系统提示词、技能、权限模式、默认模型与可检索的知识库范围。
              </p>
            </div>
            <div className="page-head-actions">
              <Button type="primary" icon={<PlusOutlined />} disabled={busy} onClick={resetForm}>
                新建助手
              </Button>
            </div>
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

          <Card
            size="small"
            title={editing ? `编辑 ${form.name}` : '新建助手'}
            style={{ marginBottom: 16 }}
          >
            <Row gutter={[16, 0]}>
              <Col xs={24} md={12}>
                <div className="admin-field">
                  <Typography.Text>名称</Typography.Text>
                  <Input
                    value={form.name}
                    maxLength={40}
                    disabled={busy}
                    placeholder="如：合同审阅助手"
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
              </Col>
              <Col xs={24} md={12}>
                <div className="admin-field">
                  <Typography.Text>简介</Typography.Text>
                  <Input
                    value={form.description}
                    maxLength={200}
                    disabled={busy}
                    placeholder="一句话说明这个助手擅长什么"
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                  />
                </div>
              </Col>
              <Col xs={24} md={12}>
                <div className="admin-field">
                  <Typography.Text>默认模型</Typography.Text>
                  <Select
                    style={{ width: '100%' }}
                    value={form.model || ''}
                    disabled={busy}
                    onChange={(value: string) => setForm({ ...form, model: value })}
                    options={[
                      { value: '', label: '跟随运营端默认模型' },
                      ...models.map((m) => ({
                        value: m.model,
                        label:
                          m.displayName && m.displayName !== m.model
                            ? `${m.displayName} · ${m.model}`
                            : m.model,
                      })),
                    ]}
                  />
                </div>
              </Col>
              <Col xs={24} md={12}>
                <div className="admin-field">
                  <Typography.Text>权限模式</Typography.Text>
                  <Select
                    style={{ width: '100%' }}
                    value={form.permissionMode}
                    disabled={busy}
                    onChange={(value: AssistantPermissionMode) =>
                      setForm({ ...form, permissionMode: value })
                    }
                    options={ASSISTANT_PERMISSION_MODES.map((mode) => ({
                      value: mode,
                      label: ASSISTANT_PERMISSION_MODE_LABELS[mode],
                    }))}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {ASSISTANT_PERMISSION_MODE_HINTS[form.permissionMode]}
                  </Typography.Text>
                </div>
              </Col>

              <Col xs={24} md={12}>
                <div className="admin-field">
                  <Typography.Text>技能</Typography.Text>
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    {ASSISTANT_SKILLS.map((s) => (
                      <Checkbox
                        key={s.key}
                        checked={form.skills.includes(s.key)}
                        disabled={busy}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            skills: e.target.checked
                              ? [...form.skills, s.key]
                              : form.skills.filter((x) => x !== s.key),
                          })
                        }
                      >
                        {s.name}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {' '}
                          · {s.description}
                        </Typography.Text>
                      </Checkbox>
                    ))}
                  </Space>
                </div>
              </Col>

              <Col xs={24} md={12}>
                <div className="admin-field">
                  <Typography.Text>知识库范围</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {form.kbIds.length === 0
                      ? '未选择时检索全部知识库'
                      : `仅检索已选的 ${form.kbIds.length} 个知识库`}
                  </Typography.Text>
                  <Select
                    mode="multiple"
                    style={{ width: '100%' }}
                    allowClear
                    disabled={busy || bases.length === 0}
                    value={form.kbIds}
                    placeholder={bases.length === 0 ? '知识库为空，可先到「知识库」页创建' : '选择要检索的知识库'}
                    onChange={(value: string[]) => setForm({ ...form, kbIds: value })}
                    options={bases.map((b) => ({
                      value: b.id,
                      label: `${b.name}（${b.docCount} 篇）`,
                    }))}
                    optionFilterProp="label"
                  />
                  {bases.length === 0 ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      知识库暂无内容，可稍后在「知识库」页创建并上传文档。
                    </Typography.Text>
                  ) : null}
                </div>
              </Col>

              <Col span={24}>
                <div className="admin-field">
                  <Typography.Text>绑定技能</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    技能内容会拼进系统提示词；不改变工具权限，工具仍由上面的技能开关决定。
                  </Typography.Text>
                  <Select
                    mode="multiple"
                    style={{ width: '100%' }}
                    allowClear
                    disabled={busy || skillCatalog.length === 0}
                    value={form.skillIds}
                    placeholder={
                      skillCatalog.length === 0
                        ? '技能市场为空，可先到「技能市场」页创建'
                        : '选择要绑定的技能'
                    }
                    onChange={(value: string[]) => setForm({ ...form, skillIds: value })}
                    options={skillCatalog.map((s) => ({
                      value: s.id,
                      label: s.scope === 'public' ? `${s.name}（公共）` : s.name,
                    }))}
                    optionFilterProp="label"
                  />
                </div>
              </Col>

              <Col span={24}>
                <div className="admin-field">
                  <Typography.Text>系统提示词</Typography.Text>
                  <Input.TextArea
                    rows={6}
                    maxLength={8000}
                    showCount
                    value={form.systemPrompt}
                    disabled={busy}
                    placeholder="描述助手的角色、目标、工作方式与输出要求。例如：你是资深合同审阅助手，逐条指出风险条款并给出修改建议…"
                    onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                  />
                </div>
              </Col>

              <Col span={24}>
                <Space>
                  <Button type="primary" loading={busy} onClick={save}>
                    {editing ? '保存' : '创建助手'}
                  </Button>
                  {editing ? (
                    <Button disabled={busy} onClick={resetForm}>
                      取消
                    </Button>
                  ) : null}
                </Space>
              </Col>
            </Row>
          </Card>

          <Card
            size="small"
            title="全部助手"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                共 {assistants.length} 个
              </Typography.Text>
            }
            loading={loading && assistants.length === 0}
          >
            {assistants.length === 0 && !loading ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Space direction="vertical" size={2}>
                    <Typography.Text>还没有自定义助手</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      新建助手后，可在工作台新建任务时选择它。
                    </Typography.Text>
                  </Space>
                }
              >
                <Button type="primary" icon={<PlusOutlined />} onClick={resetForm}>
                  新建助手
                </Button>
              </Empty>
            ) : (
              <List
                dataSource={assistants}
                rowKey="id"
                split
                renderItem={(a) => (
                  <List.Item
                    actions={[
                      <Button
                        key="edit"
                        size="small"
                        disabled={busy}
                        onClick={() => startEdit(a)}
                      >
                        编辑
                      </Button>,
                      <Button
                        key="delete"
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        disabled={busy}
                        aria-label={`删除 ${a.name}`}
                        onClick={() => remove(a)}
                      >
                        删除
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta
                      avatar={<RobotOutlined style={{ fontSize: 20, color: '#00b07b' }} />}
                      title={
                        <Space size={8} wrap>
                          <Typography.Text strong>{a.name}</Typography.Text>
                          {editing === a.id ? <Tag color="processing">编辑中</Tag> : null}
                        </Space>
                      }
                      description={
                        <Space direction="vertical" size={4} style={{ width: '100%' }}>
                          <Space size={4} wrap>
                            <Tag>{skillLabels(a.skills)}</Tag>
                            <Tag>{ASSISTANT_PERMISSION_MODE_LABELS[a.permissionMode].split('：')[0]}</Tag>
                            <Tag>{a.model || '默认模型'}</Tag>
                            <Tag color={a.kbIds.length === 0 ? undefined : 'success'}>
                              {kbSummary(a.kbIds)}
                            </Tag>
                          </Space>
                          {a.description ? (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {a.description}
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
        </div>
      </div>
    </AppShell>
  );
}
