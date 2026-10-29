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
  Modal,
  Row,
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
  type ConnectorDto,
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
  listConnectors,
  listSkills,
  updateAssistant,
} from '../../lib/api';
import { errorText } from '@ai-office/web-core';
import { AssistantEditor } from '@ai-office/web-core/assistant-editor';

interface FormState {
  name: string;
  description: string;
  systemPrompt: string;
  permissionMode: AssistantPermissionMode;
  model: string;
  skills: string[];
  /** 绑定的技能市场技能（公共或自己的个人技能）。 */
  skillIds: string[];
  /** 绑定的连接器；运行期只挂这些 MCP 连接器。 */
  connectorIds: string[];
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
  connectorIds: [],
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
  // 可绑定的连接器：账号下已启用的 MCP 连接器。
  const [connectorCatalog, setConnectorCatalog] = useState<ConnectorDto[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [formOpen, setFormOpen] = useState(false);
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
      const [rows, modelData, kbBases, skills, connectors] = await Promise.all([
        listAssistants(),
        listModels(),
        listKbBases(),
        listSkills(),
        listConnectors(),
      ]);
      setAssistants(rows);
      setModels(modelData.models);
      setBases(kbBases);
      setSkillCatalog(skills.items);
      setConnectorCatalog(connectors);
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
    setFormOpen(false);
  }

  // 列表默认就是主视图：新建/编辑表单放在弹窗里，点按钮才出现。
  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setError('');
    setFormOpen(true);
  }

  function startEdit(a: AssistantDto) {
    setEditing(a.id);
    setFormOpen(true);
    setForm({
      name: a.name,
      description: a.description,
      systemPrompt: a.systemPrompt,
      permissionMode: a.permissionMode,
      model: a.model ?? '',
      skills: a.skills,
      // 已下架/已删除的技能不保留绑定，避免保存时被服务端整单拒绝。
      skillIds: a.skillIds.filter((id) => skillCatalog.some((s) => s.id === id)),
      // 已删除的连接器同理，避免保存时被服务端拒绝。
      connectorIds: (a.connectorIds ?? []).filter((id) =>
        connectorCatalog.some((c) => c.id === id),
      ),
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
      setError('专家助手名称不能为空');
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
      connectorIds: form.connectorIds,
      kbIds: form.kbIds,
    };
    const verb = editing ? '保存修改' : '创建专家助手';
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
      title: '删除专家助手',
      content: `确认删除专家助手「${a.name}」？已创建的历史任务会退化为默认专家助手。`,
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

  // 内置（公共）与我的分开排列，避免混在一个列表里分不清归属。
  const builtinAssistants = assistants.filter((a) => a.scope === 'public');
  const myAssistants = assistants.filter((a) => a.scope !== 'public');

  function renderAssistantCard(a: AssistantDto) {
    const readonly = a.scope === 'public';
    return (
      <Card
        key={a.id}
        size="small"
        style={{ height: '100%' }}
        title={
          <Space size={6}>
            <RobotOutlined style={{ color: '#00b07b' }} />
            <Typography.Text strong ellipsis={{ tooltip: a.name }} style={{ maxWidth: 180 }}>
              {a.name}
            </Typography.Text>
            {readonly ? <Tag color="green">内置</Tag> : null}
            {editing === a.id ? <Tag color="processing">编辑中</Tag> : null}
          </Space>
        }
        extra={
          readonly ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              只读
            </Typography.Text>
          ) : (
            <Space size={0}>
              <Button size="small" type="text" disabled={busy} onClick={() => startEdit(a)}>
                编辑
              </Button>
              <Button
                size="small"
                type="text"
                danger
                disabled={busy}
                icon={<DeleteOutlined />}
                aria-label={`删除 ${a.name}`}
                onClick={() => remove(a)}
              />
            </Space>
          )
        }
      >
        <Typography.Paragraph
          type="secondary"
          style={{ marginBottom: 10, minHeight: 40 }}
          ellipsis={{ rows: 2 }}
        >
          {a.description || '暂无简介'}
        </Typography.Paragraph>
        <Space size={4} wrap>
          <Tag>{skillLabels(a.skills)}</Tag>
          <Tag>{ASSISTANT_PERMISSION_MODE_LABELS[a.permissionMode].split('：')[0]}</Tag>
          <Tag>{a.model || '系统默认模型'}</Tag>
          <Tag color={a.kbIds.length === 0 ? undefined : 'success'}>{kbSummary(a.kbIds)}</Tag>
          {a.skillIds.length > 0 ? <Tag color="purple">技能 {a.skillIds.length}</Tag> : null}
          {a.connectorIds.length > 0 ? <Tag color="blue">连接器 {a.connectorIds.length}</Tag> : null}
        </Space>
      </Card>
    );
  }

  return (
    <AppShell active="assistants">
      <div className="page-scroll">
        <div className="page">
          <header className="page-head">
            <div>
              <h1 className="page-title">我的专家助手</h1>
              <p className="page-sub">
                创建专属专家助手：设定系统提示词、技能、权限模式、默认模型与可检索的知识库范围。
              </p>
            </div>
            <div className="page-head-actions">
              <Button type="primary" icon={<PlusOutlined />} disabled={busy} onClick={openCreate}>
                新建专家助手
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

          <Modal
            open={formOpen}
            title={editing ? `编辑 ${form.name}` : '新建专家助手'}
            width={900}
            destroyOnClose
            style={{ top: 32 }}
            styles={{ body: { maxHeight: '72vh', overflowY: 'auto', paddingRight: 8 } }}
            footer={
              <Space>
                <Button disabled={busy} onClick={resetForm}>
                  取消
                </Button>
                <Button type="primary" loading={busy} onClick={save}>
                  {editing ? '保存' : '创建专家助手'}
                </Button>
              </Space>
            }
            onCancel={() => {
              if (!busy) resetForm();
            }}
          >
            <AssistantEditor
              value={form}
              onChange={(next) => setForm(next)}
              disabled={busy}
              modelOptions={models.map((m) => ({
                value: m.model,
                label:
                  m.displayName && m.displayName !== m.model
                    ? `${m.displayName} · ${m.model}`
                    : m.model,
              }))}
              skillOptions={skillCatalog.map((s) => ({
                value: s.id,
                label: s.scope === 'public' ? `${s.name}（公共）` : s.name,
              }))}
              connectorOptions={connectorCatalog.map((c) => ({ value: c.id, label: c.name }))}
              kbOptions={bases.map((b) => ({
                value: b.id,
                label: `${b.name}（${b.docCount} 篇）`,
              }))}
            />
          </Modal>

          <Card
            size="small"
            title="内置专家助手"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                共 {builtinAssistants.length} 个
              </Typography.Text>
            }
            style={{ marginBottom: 16 }}
            loading={loading && assistants.length === 0}
          >
            {builtinAssistants.length === 0 && !loading ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无内置专家助手" />
            ) : (
              <Row gutter={[12, 12]}>
                {builtinAssistants.map((a) => (
                  <Col key={a.id} xs={24} md={12} xl={8}>
                    {renderAssistantCard(a)}
                  </Col>
                ))}
              </Row>
            )}
          </Card>

          <Card
            size="small"
            title="我的专家助手"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                共 {myAssistants.length} 个
              </Typography.Text>
            }
            loading={loading && assistants.length === 0}
          >
            {myAssistants.length === 0 && !loading ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Space direction="vertical" size={2}>
                    <Typography.Text>还没有自定义专家助手</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      新建专家助手后，可在工作台新建任务时选择它。
                    </Typography.Text>
                  </Space>
                }
              >
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                  新建专家助手
                </Button>
              </Empty>
            ) : (
              <Row gutter={[12, 12]}>
                {myAssistants.map((a) => (
                  <Col key={a.id} xs={24} md={12} xl={8}>
                    {renderAssistantCard(a)}
                  </Col>
                ))}
              </Row>
            )}
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
