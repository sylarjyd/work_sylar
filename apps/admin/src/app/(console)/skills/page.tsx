'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  App,
  Button,
  Card,
  Input,
  List,
  Modal,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import type { SkillDto, SkillInput } from '@ai-office/shared';
import {
  adminErrorText,
  deleteAdminSkill,
  downloadAdminSkillFile,
  getAdminSkillPackage,
  getAdminModels,
  isForbidden,
  listAdminSkills,
  saveAdminSkillPackage,
  setAdminSkillEnabled,
  testAdminSkill,
  uploadAdminSkillPackage,
} from '../../../lib/admin-api';
import { clearToken, isUnauthorized } from '@ai-office/web-core';
import { SkillDetailDialog } from '@ai-office/web-core/skill-detail';
import { SkillEditor, type SkillEditorValue } from '@ai-office/web-core/skill-editor';
import { SkillTestDialog } from '@ai-office/web-core/skill-test';

const PAGE_SIZE = 20;

const EMPTY_VALUE: SkillEditorValue = {
  meta: { name: '', slug: '', description: '', content: '' },
  files: [],
  binary: [],
};

interface UploadFailure {
  name: string;
  error: string;
}

/** 技能包解析错误码 → 可读文案；批量上传时逐条展示。 */
function uploadErrorText(err: unknown): string {
  const code = err instanceof Error ? err.message : '';
  const map: Record<string, string> = {
    skill_md_missing: 'zip 里没有 SKILL.md',
    frontmatter_missing: 'SKILL.md 缺少 --- frontmatter ---',
    frontmatter_invalid: 'SKILL.md frontmatter 不是合法 YAML',
    invalid_name: 'frontmatter.name 必须是英文小写、数字和连字符',
    description_required: 'frontmatter 必须包含 description',
    package_too_large: '技能包不能超过 10MB',
    file_too_large: '包内单个文件不能超过 5MB',
    invalid_path: '技能包里有非法路径',
    invalid_zip: '不是合法的 zip 文件',
    empty_package: '技能包是空的',
    too_many_files: '包内文件超过 200 个',
  };
  return map[code] ?? '上传失败，请检查技能包格式';
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
  const [detailFor, setDetailFor] = useState<SkillDto | null>(null);
  const [editor, setEditor] = useState<{
    mode: 'create' | 'edit';
    id?: string;
    value: SkillEditorValue;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testFor, setTestFor] = useState<SkillDto | null>(null);
  const [testModels, setTestModels] = useState<{ value: string; label: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadReport, setUploadReport] = useState<UploadFailure[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loadSeq = useRef(0);
  const inFlight = useRef(false);
  const uploadRef = useRef<HTMLInputElement>(null);

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

  async function openTest(item: SkillDto): Promise<void> {
    setTestFor(item);
    if (testModels.length > 0) return;
    try {
      // 模型清单来自运营端模型库；字段差异时降级为空列表（测试仍用默认模型）。
      const data = (await getAdminModels()) as unknown as { models?: Array<{ model?: string }> };
      setTestModels(
        (data.models ?? [])
          .map((item2) => item2.model ?? '')
          .filter((value) => value !== '')
          .map((value) => ({ value, label: value })),
      );
    } catch (err) {
      handleErr(err);
    }
  }

  async function openEditor(item?: SkillDto) {
    if (inFlight.current) return;
    if (!item) {
      setEditor({ mode: 'create', value: EMPTY_VALUE });
      return;
    }
    inFlight.current = true;
    setError('');
    try {
      const contents = await getAdminSkillPackage(item.id);
      setEditor({
        mode: 'edit',
        id: item.id,
        value: {
          meta: {
            name: item.name,
            slug: item.slug,
            description: item.description,
            content: item.content,
            version: item.version ?? '',
            license: item.license ?? '',
            allowedTools: item.allowedTools,
          },
          files: contents.files,
          binary: contents.binary,
        },
      });
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
    }
  }

  async function saveEditor(payload: {
    meta: SkillInput;
    files: Array<{ path: string; content: string }>;
    deleted: string[];
  }): Promise<void> {
    if (!editor) return;
    setSaving(true);
    setError('');
    try {
      await saveAdminSkillPackage(payload, editor.mode === 'edit' ? editor.id : undefined);
      setEditor(null);
      await loadRef.current();
      void message.success('已保存');
    } catch (err) {
      handleErr(err);
    } finally {
      setSaving(false);
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

  /** 批量上传：逐个串行提交，失败的集中展示。 */
  async function uploadPackage(files: File[]) {
    if (uploading || files.length === 0) return;
    setUploading(true);
    setError('');
    let ok = 0;
    const failed: UploadFailure[] = [];
    for (const file of files) {
      if (!/\.zip$/i.test(file.name)) {
        failed.push({ name: file.name, error: '只支持 .zip 技能包' });
        continue;
      }
      try {
        await uploadAdminSkillPackage(file);
        ok += 1;
      } catch (err) {
        failed.push({ name: file.name, error: uploadErrorText(err) });
      }
    }
    await loadRef.current();
    setUploading(false);
    if (uploadRef.current) uploadRef.current.value = '';
    if (ok > 0) void message.success(`已上传 ${ok} 个技能包`);
    if (failed.length > 0) setUploadReport(failed);
  }

  const columns: TableColumnsType<SkillDto> = [
    {
      title: '技能',
      dataIndex: 'name',
      width: 260,
      render: (_: unknown, item) => (
        // 简介可能很长：单行省略并在悬浮时给全文，避免整行被撑高。
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
      render: (_: unknown, item) =>
        item.source === 'run' ? '任务总结' : item.source === 'upload' ? '技能包' : '手工创建',
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
      title: '文件',
      key: 'files',
      width: 90,
      render: (_: unknown, item) =>
        item.files.length > 0 ? (
          <Typography.Text>{item.files.length} 个</Typography.Text>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
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
      width: 290,
      render: (_: unknown, item) =>
        item.scope === 'public' ? (
          <Space size={4}>
            <Button size="small" onClick={() => void openTest(item)}>
              测试
            </Button>
            <Button size="small" onClick={() => setDetailFor(item)}>
              详情
            </Button>
            <Button
              size="small"
              disabled={busy}
              onClick={() => void openEditor(item)}
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
          <Space size={4}>
            <Button size="small" onClick={() => setDetailFor(item)}>
              详情
            </Button>
            <Typography.Text type="secondary">只读</Typography.Text>
          </Space>
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
              onClick={() => void openEditor()}
            >
              新建公共技能
            </Button>
            <Button
              icon={<UploadOutlined />}
              loading={uploading}
              disabled={busy}
              onClick={() => uploadRef.current?.click()}
            >
              上传技能包
            </Button>
            <input
              ref={uploadRef}
              type="file"
              accept=".zip,application/zip"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) void uploadPackage(files);
              }}
            />
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

      <SkillEditor
        open={editor !== null}
        mode={editor?.mode ?? 'create'}
        initial={editor?.value ?? EMPTY_VALUE}
        saving={saving}
        onCancel={() => setEditor(null)}
        onSubmit={(payload) => void saveEditor(payload)}
      />

      <Modal
        open={uploadReport !== null}
        title="部分技能包上传失败"
        width={560}
        okText="知道了"
        cancelButtonProps={{ style: { display: 'none' } }}
        onOk={() => setUploadReport(null)}
        onCancel={() => setUploadReport(null)}
      >
        <List
          size="small"
          dataSource={uploadReport ?? []}
          renderItem={(item) => (
            <List.Item>
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Typography.Text>{item.name}</Typography.Text>
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  {item.error}
                </Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      </Modal>

      <SkillTestDialog
        open={testFor !== null}
        skill={testFor}
        models={testModels}
        onClose={() => setTestFor(null)}
        onRun={(model, prompt) => testAdminSkill(testFor!.id, { model, prompt })}
      />

      <SkillDetailDialog
        open={detailFor !== null}
        skill={detailFor}
        onClose={() => setDetailFor(null)}
        onDownloadFile={(skill, path) =>
          void downloadAdminSkillFile(skill.id, path, path.split('/').pop() ?? 'file').catch((err) =>
            handleErr(err),
          )
        }
        extra={
          detailFor?.scope === 'public' ? (
            <Button
              onClick={() => {
                const target = detailFor;
                if (!target) return;
                setDetailFor(null);
                void openEditor(target);
              }}
            >
              编辑
            </Button>
          ) : null
        }
      />
    </Space>
  );
}
