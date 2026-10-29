'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Col,
  Empty,
  Form,
  Input,
  Modal,
  Row,
  Space,
  Tooltip,
  Tree,
  Typography,
} from 'antd';
import {
  SKILL_LIMITS,
  SKILL_SLUG_PATTERN,
  slugifySkillName,
  type SkillFileContent,
  type SkillFileEntry,
  type SkillInput,
} from '@ai-office/shared';
import { SKILL_MD_KEY, buildSkillTree, type SkillTreeNode } from './skill-tree';

const KEEP_FILE = '.gitkeep';

export interface SkillEditorValue {
  meta: SkillInput;
  files: SkillFileContent[];
  /** 二进制文件：只展示，保存时原样保留。 */
  binary: SkillFileEntry[];
}

export interface SkillEditorSubmit {
  meta: SkillInput;
  files: SkillFileContent[];
  deleted: string[];
}

export interface SkillEditorProps {
  open: boolean;
  mode: 'create' | 'edit';
  initial: SkillEditorValue;
  saving?: boolean;
  onCancel: () => void;
  onSubmit: (payload: SkillEditorSubmit) => void;
}

const EMPTY_VALUE: SkillEditorValue = {
  meta: { name: '', slug: '', description: '', content: '' },
  files: [],
  binary: [],
};

/** 空目录用 .gitkeep 占位，展示时隐藏，避免把实现细节暴露给用户。 */
function hideKeepFiles(nodes: readonly SkillTreeNode[]): SkillTreeNode[] {
  return nodes
    .filter((node) => !(node.isLeaf && node.title === KEEP_FILE))
    .map((node) =>
      node.children && node.children.length > 0
        ? { ...node, children: hideKeepFiles(node.children) }
        : node,
    )
    .filter((node) => node.isLeaf || (node.children?.length ?? 0) > 0);
}

function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at >= 0 ? path.slice(0, at) : '';
}

/**
 * 技能编辑器：左侧目录树（SKILL.md + 包内文件），右侧改 frontmatter 或文件内容。
 * 目录/文件都是虚拟视图，保存时整体重新打包成 zip。
 */
export function SkillEditor({
  open,
  mode,
  initial,
  saving = false,
  onCancel,
  onSubmit,
}: SkillEditorProps) {
  const [meta, setMeta] = useState<SkillInput>(EMPTY_VALUE.meta);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [originalPaths, setOriginalPaths] = useState<string[]>([]);
  const [binary, setBinary] = useState<SkillFileEntry[]>([]);
  const [removedBinary, setRemovedBinary] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>(SKILL_MD_KEY);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [creating, setCreating] = useState<{ kind: 'file' | 'dir' } | null>(null);
  const [newPath, setNewPath] = useState('');
  const [newContent, setNewContent] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const nextFiles: Record<string, string> = {};
    for (const file of initial.files) nextFiles[file.path] = file.content;
    // 空目录占位文件存在但内容为空：保留在数据里，树里隐藏。
    setMeta(initial.meta);
    setFiles(nextFiles);
    setOriginalPaths(Object.keys(nextFiles));
    setBinary(initial.binary);
    setSelected(SKILL_MD_KEY);
    // 默认展开全部目录：从初始路径推导，避免每次编辑文件都重置展开状态。
    const dirs = new Set<string>();
    for (const path of [
      ...initial.files.map((file) => file.path),
      ...initial.binary.map((file) => file.path),
    ]) {
      const parts = path.split('/');
      parts.pop();
      let acc = '';
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        dirs.add(acc);
      }
    }
    setExpanded([...dirs]);
    setRemovedBinary([]);
    setError('');
  }, [open, initial]);

  const tree = useMemo(() => {
    const entries: SkillFileEntry[] = [
      ...Object.keys(files).map((path) => ({
        path,
        size: new TextEncoder().encode(files[path] ?? '').byteLength,
      })),
      ...binary.map((file) => ({ path: file.path, size: file.size })),
    ];
    return hideKeepFiles(buildSkillTree(entries));
  }, [files, binary]);

  const currentIsSkillMd = selected === SKILL_MD_KEY;
  const currentFile = !currentIsSkillMd && selected in files ? selected : null;
  const currentBinary = binary.find((file) => file.path === selected) ?? null;

  function openCreate(kind: 'file' | 'dir'): void {
    const dir = currentFile ? dirOf(currentFile) : '';
    setCreating({ kind });
    setNewPath(dir ? `${dir}/` : '');
    setNewContent('');
    setError('');
  }

  function confirmCreate(): void {
    if (!creating) return;
    const raw = newPath.trim().replace(/^\/+|\/+$/g, '');
    if (!raw) {
      setError('路径不能为空');
      return;
    }
    if (raw.startsWith('/') || raw.includes('\\') || raw.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      setError('路径不合法：用相对路径，不要包含 .. 或反斜杠');
      return;
    }
    if (creating.kind === 'dir') {
      const key = `${raw}/${KEEP_FILE}`;
      if (files[key] !== undefined || binary.some((file) => file.path === key)) {
        setError('目录已存在');
        return;
      }
      setFiles((prev) => ({ ...prev, [key]: '' }));
      setSelected(key);
    } else {
      const path = raw;
      if (files[path] !== undefined || binary.some((file) => file.path === path)) {
        setError('文件已存在');
        return;
      }
      setFiles((prev) => ({ ...prev, [path]: newContent }));
      setSelected(path);
    }
    setCreating(null);
  }

  function removeCurrent(): void {
    if (currentIsSkillMd) return;
    const path = currentBinary?.path ?? currentFile;
    if (!path) return;
    if (currentFile) {
      setFiles((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
    } else {
      setBinary((prev) => prev.filter((file) => file.path !== path));
      setRemovedBinary((prev) => [...prev, path]);
    }
    setSelected(SKILL_MD_KEY);
  }

  function submit(): void {
    const name = meta.name.trim();
    const content = meta.content.trim();
    if (!name) {
      setError('技能名称不能为空');
      return;
    }
    if (!content) {
      setError('SKILL.md 正文不能为空');
      return;
    }
    const slug = (meta.slug ?? '').trim().toLowerCase() || slugifySkillName(name);
    if (slug && !SKILL_SLUG_PATTERN.test(slug)) {
      setError('技能标识只能用小写字母、数字和连字符（如 weekly-report）');
      return;
    }
    setError('');
    const payloadFiles = Object.entries(files).map(([path, value]) => ({ path, content: value }));
    const currentPaths = new Set(payloadFiles.map((file) => file.path));
    // 二进制文件不在文本编辑范围里，保留清单，不算删除；显式移除的单独上报。
    const deleted = [
      ...originalPaths.filter((path) => !currentPaths.has(path)),
      ...removedBinary,
    ];
    onSubmit({
      meta: { ...meta, name, slug, content },
      files: payloadFiles,
      deleted,
    });
  }

  return (
    <Modal
      open={open}
      title={mode === 'create' ? '新建技能' : '编辑技能'}
      width={1040}
      onCancel={saving ? undefined : onCancel}
      footer={
        <Space>
          <Button onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button type="primary" loading={saving} onClick={submit}>
            保存
          </Button>
        </Space>
      }
      destroyOnClose
    >
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      <div style={{ display: 'flex', gap: 16, minHeight: 460 }}>
        <div
          style={{
            width: 300,
            flex: '0 0 300px',
            borderRight: '1px solid #f0f0f0',
            paddingRight: 12,
            maxHeight: 540,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Space size={4} style={{ marginBottom: 8 }}>
            <Tooltip title="新建文件（可输入 a/b.md 自动建目录）">
              <Button size="small" onClick={() => openCreate('file')}>
                + 文件
              </Button>
            </Tooltip>
            <Tooltip title="新建空目录（用 .gitkeep 占位）">
              <Button size="small" onClick={() => openCreate('dir')}>
                + 目录
              </Button>
            </Tooltip>
            <Tooltip title={currentIsSkillMd ? 'SKILL.md 不能删除' : '删除选中项'}>
              <Button
                size="small"
                danger
                disabled={currentIsSkillMd || (!currentFile && !currentBinary)}
                onClick={removeCurrent}
              >
                删除
              </Button>
            </Tooltip>
          </Space>
          <div style={{ overflow: 'auto', flex: 1 }}>
            <Tree
              treeData={tree}
              selectedKeys={[selected]}
              expandedKeys={expanded}
              onExpand={(keys) => setExpanded(keys.map(String))}
              onSelect={(keys) => {
                if (keys.length > 0) setSelected(String(keys[0]));
              }}
              showLine
              blockNode
            />
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, maxHeight: 540, overflow: 'auto' }}>
          {currentIsSkillMd ? (
            <Form layout="vertical" size="small">
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="技能标识（frontmatter name）">
                    <Input
                      value={meta.slug ?? ''}
                      maxLength={SKILL_LIMITS.slug}
                      placeholder="weekly-report；留空按名称生成"
                      onChange={(e) => setMeta({ ...meta, slug: e.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="技能名称">
                    <Input
                      value={meta.name}
                      maxLength={SKILL_LIMITS.name}
                      placeholder="如：周报撰写规范"
                      onChange={(e) => setMeta({ ...meta, name: e.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="简介（frontmatter description）">
                    <Input
                      value={meta.description ?? ''}
                      maxLength={SKILL_LIMITS.description}
                      placeholder="一句话说明什么时候用这个技能"
                      onChange={(e) => setMeta({ ...meta, description: e.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="版本（可选）">
                    <Input
                      value={meta.version ?? ''}
                      maxLength={40}
                      placeholder="1.0.0"
                      onChange={(e) => setMeta({ ...meta, version: e.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="许可（可选）">
                    <Input
                      value={meta.license ?? ''}
                      maxLength={80}
                      placeholder="MIT"
                      onChange={(e) => setMeta({ ...meta, license: e.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="allowed-tools（空格分隔）">
                    <Input
                      value={(meta.allowedTools ?? []).join(' ')}
                      placeholder="Read Write"
                      onChange={(e) =>
                        setMeta({
                          ...meta,
                          allowedTools: e.target.value.split(/\s+/).filter(Boolean),
                        })
                      }
                    />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="正文（frontmatter 之后的指令，会拼进系统提示词）">
                    <Input.TextArea
                      rows={14}
                      maxLength={SKILL_LIMITS.content}
                      showCount
                      value={meta.content}
                      placeholder={'适用场景：……\n步骤：1) … 2) …\n注意：……'}
                      onChange={(e) => setMeta({ ...meta, content: e.target.value })}
                    />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
          ) : currentFile ? (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Typography.Text code>{currentFile}</Typography.Text>
              <Input.TextArea
                rows={22}
                style={{ fontFamily: 'Consolas, monospace' }}
                value={files[currentFile] ?? ''}
                onChange={(e) => setFiles((prev) => ({ ...prev, [currentFile]: e.target.value }))}
              />
            </Space>
          ) : currentBinary ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={`${currentBinary.path} 是二进制文件（${currentBinary.size} B），不能在线编辑；保存时会原样保留`}
            />
          ) : null}
        </div>
      </div>

      <Modal
        open={creating !== null}
        title={creating?.kind === 'dir' ? '新建目录' : '新建文件'}
        okText="创建"
        cancelText="取消"
        onOk={confirmCreate}
        onCancel={() => setCreating(null)}
        destroyOnClose
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary">
              {creating?.kind === 'dir' ? '目录路径（会自动建父级）' : '文件路径（可输入 a/b.md）'}
            </Typography.Text>
            <Input
              style={{ marginTop: 4 }}
              value={newPath}
              autoFocus
              placeholder={creating?.kind === 'dir' ? 'references' : 'references/template.md'}
              onChange={(e) => setNewPath(e.target.value)}
              onPressEnter={confirmCreate}
            />
          </div>
          {creating?.kind === 'file' ? (
            <div>
              <Typography.Text type="secondary">初始内容（可留空）</Typography.Text>
              <Input.TextArea
                style={{ marginTop: 4 }}
                rows={8}
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
              />
            </div>
          ) : null}
        </Space>
      </Modal>
    </Modal>
  );
}
