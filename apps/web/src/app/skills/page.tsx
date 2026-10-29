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
  Row,
  Segmented,
  Space,
  Tag,
  Typography,
} from 'antd';
import { BulbOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import type { SkillDto } from '@ai-office/shared';
import { AppShell } from '../../components/app-shell';
import {
  deleteSkill,
  downloadSkillFile,
  getSkillPackage,
  getToken,
  isUnauthorized,
  listSkills,
  saveSkillPackage,
  shareSkill,
  uploadSkillPackage,
} from '../../lib/api';
import { errorText } from '@ai-office/web-core';
import { SkillDetailDialog } from '@ai-office/web-core/skill-detail';
import { SkillEditor, type SkillEditorValue } from '@ai-office/web-core/skill-editor';

type Filter = 'all' | 'mine' | 'public';

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

const EMPTY_VALUE: SkillEditorValue = {
  meta: { name: '', slug: '', description: '', content: '' },
  files: [],
  binary: [],
};

/** 技能市场（用户侧）：公共技能人人可见；个人技能仅自己可见，可共享为公共。 */
export default function SkillsPage() {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [items, setItems] = useState<SkillDto[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [detailFor, setDetailFor] = useState<SkillDto | null>(null);
  const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; id?: string; value: SkillEditorValue } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loadSeq = useRef(0);
  const inFlight = useRef(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const handleErr = useCallback(
    (err: unknown): void => {
      if (isUnauthorized(err)) {
        router.replace('/login');
        return;
      }
      setError(errorText(err));
    },
    [router],
  );

  const load = useCallback(async (): Promise<void> => {
    const id = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const data = await listSkills();
      if (id !== loadSeq.current) return;
      setItems(data.items);
    } catch (err) {
      if (id !== loadSeq.current) return;
      handleErr(err);
    } finally {
      if (id === loadSeq.current) setLoading(false);
    }
  }, [handleErr]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    void load();
  }, [load, router]);

  function openCreate(): void {
    setEditor({ mode: 'create', value: EMPTY_VALUE });
  }

  async function openEdit(item: SkillDto): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setError('');
    try {
      const contents = await getSkillPackage(item.id);
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
    meta: Parameters<typeof saveSkillPackage>[0]['meta'];
    files: Array<{ path: string; content: string }>;
    deleted: string[];
  }): Promise<void> {
    if (!editor) return;
    setSaving(true);
    setError('');
    try {
      await saveSkillPackage(payload, editor.mode === 'edit' ? editor.id : undefined);
      setEditor(null);
      await loadRef.current();
      void message.success('已保存');
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      const map: Record<string, string> = {
        skill_save_failed_400: '保存失败：请检查技能标识、文件路径与大小限制',
        skill_save_failed_413: '内容过大',
      };
      if (map[code]) setError(map[code]);
      else handleErr(err);
    } finally {
      setSaving(false);
    }
  }

  async function upload(file: File) {
    if (uploading) return;
    if (!/\.zip$/i.test(file.name)) {
      void message.error('技能包必须是 .zip');
      return;
    }
    setUploading(true);
    setError('');
    try {
      await uploadSkillPackage(file);
      await loadRef.current();
      void message.success('技能包已上传');
    } catch (err) {
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
      };
      if (map[code]) setError(map[code]);
      else handleErr(err);
    } finally {
      setUploading(false);
      if (uploadRef.current) uploadRef.current.value = '';
    }
  }

  function share(item: SkillDto) {
    if (inFlight.current) return;
    modal.confirm({
      title: '共享为公共技能',
      content: `共享后「${item.name}」将出现在技能市场，所有用户可见并可在助手中绑定；之后由运营端维护，你将不能再编辑它。`,
      okText: '共享',
      cancelText: '取消',
      onOk: async () => {
        inFlight.current = true;
        setBusy(true);
        try {
          await shareSkill(item.id);
          await loadRef.current();
          void message.success('已共享为公共技能');
        } catch (err) {
          handleErr(err);
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      },
    });
  }

  function remove(item: SkillDto) {
    if (inFlight.current) return;
    modal.confirm({
      title: '确认删除技能',
      content: `确认删除「${item.name}」？已绑定该技能的助手将不再注入其内容。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        inFlight.current = true;
        setBusy(true);
        try {
          await deleteSkill(item.id);
          await loadRef.current();
        } catch (err) {
          handleErr(err);
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      },
    });
  }

  const visible = items.filter((item) => {
    if (filter === 'mine') return item.owned;
    if (filter === 'public') return item.scope === 'public';
    return true;
  });

  return (
    <AppShell active="skills">
      <div className="page-scroll">
        <div className="page">
          <header className="page-head">
            <div>
              <Typography.Title level={4} style={{ margin: 0 }}>
                技能市场
              </Typography.Title>
              <Typography.Text type="secondary">
                把一套做法沉淀成技能：SKILL.md 写清适用场景与步骤，还可以附带脚本、模板等文件。绑定到助手后会在执行任务时自动注入。
              </Typography.Text>
            </div>
            <Space wrap>
              <Segmented
                value={filter}
                onChange={(value) => setFilter(value as Filter)}
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'mine', label: '我的' },
                  { value: 'public', label: '公共' },
                ]}
              />
              <Button type="primary" icon={<PlusOutlined />} disabled={busy} onClick={openCreate}>
                新建技能
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
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
            </Space>
          </header>

          {error ? <Alert type="error" showIcon message={error} /> : null}

          {loading ? (
            <Card loading />
          ) : visible.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={filter === 'mine' ? '还没有个人技能，点右上角新建' : '暂无技能'}
            >
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新建技能
              </Button>
            </Empty>
          ) : (
            <Row gutter={[12, 12]}>
              {visible.map((item) => (
                <Col key={item.id} xs={24} md={12} xl={8}>
                  <Card
                    size="small"
                    style={{ height: '100%' }}
                    title={
                      <Space size={8}>
                        <BulbOutlined />
                        <Typography.Text strong>{item.name}</Typography.Text>
                        {item.scope === 'public' ? <Tag color="green">公共</Tag> : <Tag>个人</Tag>}
                        {item.source === 'run' ? <Tag color="blue">任务总结</Tag> : null}
                        {item.source === 'upload' ? <Tag color="purple">技能包</Tag> : null}
                      </Space>
                    }
                    extra={
                      <Space size={4}>
                        <Button size="small" onClick={() => setDetailFor(item)}>
                          详情
                        </Button>
                        {item.owned && item.scope === 'personal' ? (
                          <>
                            <Button size="small" disabled={busy} onClick={() => void openEdit(item)}>
                              编辑
                            </Button>
                            <Button size="small" disabled={busy} onClick={() => share(item)}>
                              共享
                            </Button>
                            <Button size="small" danger disabled={busy} onClick={() => remove(item)}>
                              删除
                            </Button>
                          </>
                        ) : item.owned ? (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            已共享
                          </Typography.Text>
                        ) : null}
                      </Space>
                    }
                  >
                    {item.description ? (
                      <Typography.Paragraph style={{ marginBottom: 8 }} ellipsis={{ rows: 2 }}>
                        {item.description}
                      </Typography.Paragraph>
                    ) : null}
                    <Typography.Paragraph
                      type="secondary"
                      style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}
                      ellipsis={{ rows: 3 }}
                    >
                      {item.content}
                    </Typography.Paragraph>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {item.files.length > 0 ? `${item.files.length} 个文件 · ` : ''}更新于{' '}
                      {formatTime(item.updatedAt)}
                    </Typography.Text>
                  </Card>
                </Col>
              ))}
            </Row>
          )}
        </div>
      </div>

      <SkillEditor
        open={editor !== null}
        mode={editor?.mode ?? 'create'}
        initial={editor?.value ?? EMPTY_VALUE}
        saving={saving}
        onCancel={() => setEditor(null)}
        onSubmit={(payload) => void saveEditor(payload)}
      />

      <SkillDetailDialog
        open={detailFor !== null}
        skill={detailFor}
        onClose={() => setDetailFor(null)}
        onDownloadFile={(skill, path) =>
          void downloadSkillFile(skill.id, path, path.split('/').pop() ?? 'file').catch((err) =>
            handleErr(err),
          )
        }
      />
    </AppShell>
  );
}
