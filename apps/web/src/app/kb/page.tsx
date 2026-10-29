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
  Form,
  Input,
  List,
  Modal,
  Row,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { DeleteOutlined, InboxOutlined, PlusOutlined } from '@ant-design/icons';
import type { KbBaseDto, KbDocDto } from '@ai-office/shared';
import { AppShell } from '../../components/app-shell';
import {
  createKbBase,
  deleteKbBase,
  deleteKbBaseDoc,
  getToken,
  isUnauthorized,
  kbErrorText,
  listKbBaseDocs,
  listKbBases,
  updateKbBase,
  uploadKbBaseDoc,
} from '../../lib/api';
import { errorText } from '@ai-office/web-core';
import { formatBytes } from '../../lib/format';

const ACCEPT = '.txt,.md,.csv,.docx,.xlsx,.pdf';
const POLL_MS = 2500;

const STATUS_LABEL: Record<KbDocDto['status'], string> = {
  pending: '摄取中',
  ready: '就绪',
  failed: '失败',
};

interface BaseFormValues {
  name: string;
  description: string;
}

interface BaseModalState {
  mode: 'create' | 'rename';
  base?: KbBaseDto;
}

function baseStatusTag(base: KbBaseDto) {
  if (base.failedCount > 0) return <Tag color="error">{base.failedCount} 篇失败</Tag>;
  if (base.pendingCount > 0) return <Tag color="processing">摄取中</Tag>;
  if (base.docCount === 0) return <Tag>空</Tag>;
  return <Tag color="success">{base.readyCount} 篇就绪</Tag>;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export default function KbPage() {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [bases, setBases] = useState<KbBaseDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [docs, setDocs] = useState<KbDocDto[]>([]);
  const [basesLoading, setBasesLoading] = useState(true);
  const [docsLoading, setDocsLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [modalState, setModalState] = useState<BaseModalState | null>(null);
  const [saving, setSaving] = useState(false);

  const [form] = Form.useForm<BaseFormValues>();
  // 过期响应保护：只让最后一次请求写状态。
  const basesSeq = useRef(0);
  const docsSeq = useRef(0);
  const inFlight = useRef(false);
  // 轮询与回调需要读到最新选中项，避免闭包里的旧值覆盖。
  const selectedRef = useRef<string | null>(null);

  const selected = bases.find((b) => b.id === selectedId) ?? null;

  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  const handleErr = useCallback(
    (err: unknown): boolean => {
      if (isUnauthorized(err)) {
        router.push('/login');
        return true;
      }
      setError(kbErrorText(err, errorText));
      return false;
    },
    [router],
  );

  const loadBases = useCallback(
    async (silent = false) => {
      const id = ++basesSeq.current;
      if (!silent) {
        setBasesLoading(true);
        setError('');
      }
      try {
        const rows = await listKbBases();
        if (id !== basesSeq.current) return;
        setBases(rows);
        // 选中项被删除或首次进入时，落到第一个库。
        const current = selectedRef.current;
        if (!current || !rows.some((b) => b.id === current)) {
          setSelectedId(rows[0]?.id ?? null);
        }
      } catch (err) {
        if (id === basesSeq.current) handleErr(err);
      } finally {
        if (id === basesSeq.current) setBasesLoading(false);
      }
    },
    [handleErr],
  );

  const loadDocs = useCallback(
    async (baseId: string, silent = false) => {
      const id = ++docsSeq.current;
      if (!silent) setDocsLoading(true);
      try {
        const rows = await listKbBaseDocs(baseId);
        // 切换知识库后旧库的响应必须丢弃。
        if (id !== docsSeq.current || selectedRef.current !== baseId) return;
        setDocs(rows);
      } catch (err) {
        if (id !== docsSeq.current) return;
        // 库在别处被删除时回到加载列表，由 bases 刷新把选中项挪走。
        handleErr(err);
      } finally {
        if (id === docsSeq.current) setDocsLoading(false);
      }
    },
    [handleErr],
  );

  useEffect(() => {
    if (!getToken()) {
      router.push('/login');
      return;
    }
    void loadBases();
  }, [loadBases, router]);

  useEffect(() => {
    if (!selectedId) {
      docsSeq.current += 1;
      setDocs([]);
      setDocsLoading(false);
      return;
    }
    void loadDocs(selectedId);
  }, [selectedId, loadDocs]);

  // 仅在存在 pending 文档时轮询当前库与库计数；全部落定后自动停止。
  const hasPending = docs.some((d) => d.status === 'pending');
  useEffect(() => {
    if (!hasPending || !selectedId) return;
    const timer = window.setInterval(() => {
      void loadDocs(selectedId, true);
      void loadBases(true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasPending, selectedId, loadDocs, loadBases]);

  function openCreate() {
    setModalState({ mode: 'create' });
  }

  function openRename(base: KbBaseDto) {
    setModalState({ mode: 'rename', base });
  }

  async function submitModal() {
    if (inFlight.current || !modalState) return;
    let values: BaseFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // 校验失败的提示由 Form 自己渲染。
    }
    inFlight.current = true;
    setSaving(true);
    setError('');
    const name = values.name.trim();
    const description = values.description.trim();
    try {
      if (modalState.mode === 'create') {
        const created = await createKbBase({ name, description });
        message.success(`已创建知识库「${created.name}」`);
        setModalState(null);
        setSelectedId(created.id);
        await loadBases(true);
      } else if (modalState.base) {
        await updateKbBase(modalState.base.id, { name, description });
        message.success('已保存');
        setModalState(null);
        await loadBases(true);
      }
    } catch (err) {
      if (!handleErr(err)) {
        // 弹窗保持打开，用户可修正名称后重试。
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  function removeBase(base: KbBaseDto) {
    if (inFlight.current) return;
    modal.confirm({
      title: '删除知识库',
      content: `确认删除「${base.name}」及其 ${base.docCount} 篇文档？此操作不可恢复，相关专家助手将不再检索该库。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => runRemoveBase(base),
    });
  }

  async function runRemoveBase(base: KbBaseDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await deleteKbBase(base.id);
      if (result.cleanupFailed > 0) {
        message.warning(`已删除知识库，但有 ${result.cleanupFailed} 个存储对象清理失败，请联系管理员处理。`);
      } else {
        message.success(`已删除知识库「${base.name}」`);
      }
      if (selectedRef.current === base.id) setSelectedId(null);
      await loadBases(true);
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
    }
  }

  function removeDoc(doc: KbDocDto) {
    if (inFlight.current || !selectedId) return;
    const baseId = selectedId;
    modal.confirm({
      title: '删除文档',
      content: `确认删除「${doc.filename}」？其切片会一并移除，此操作不可恢复。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => runRemoveDoc(baseId, doc),
    });
  }

  async function runRemoveDoc(baseId: string, doc: KbDocDto) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await deleteKbBaseDoc(baseId, doc.id);
      if (result.cleanupFailed > 0) {
        message.warning(`已删除文档，但有 ${result.cleanupFailed} 个存储对象清理失败，请联系管理员处理。`);
      } else {
        message.success(`已删除「${doc.filename}」`);
      }
      setDocs((prev) => prev.filter((d) => d.id !== doc.id));
      await loadBases(true);
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
    }
  }

  async function upload(file: File) {
    if (!selectedId || inFlight.current) return;
    const baseId = selectedId;
    inFlight.current = true;
    setUploading(true);
    setError('');
    try {
      const doc = await uploadKbBaseDoc(baseId, file);
      message.success(`「${doc.filename}」已上传，正在解析`);
      if (selectedRef.current === baseId) {
        setDocs((prev) => [doc, ...prev.filter((d) => d.id !== doc.id)]);
      }
      await loadBases(true);
    } catch (err) {
      handleErr(err);
    } finally {
      inFlight.current = false;
      setUploading(false);
    }
  }

  const columns: TableColumnsType<KbDocDto> = [
    {
      title: '文档',
      dataIndex: 'filename',
      ellipsis: true,
      render: (v: string) => <Typography.Text>{v}</Typography.Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status: KbDocDto['status']) =>
        status === 'ready' ? (
          <Tag color="success">{STATUS_LABEL[status]}</Tag>
        ) : status === 'pending' ? (
          <Tag color="processing">{STATUS_LABEL[status]}</Tag>
        ) : (
          <Tag color="error">{STATUS_LABEL[status]}</Tag>
        ),
    },
    { title: '切片', dataIndex: 'chunkCount', width: 90, align: 'right' },
    {
      title: '大小',
      dataIndex: 'size',
      width: 110,
      align: 'right',
      render: (v: number) => formatBytes(v),
    },
    {
      title: '上传时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (v: string) => formatTime(v),
    },
    {
      title: '错误',
      dataIndex: 'error',
      ellipsis: true,
      render: (v: string | null) =>
        v ? <Typography.Text type="danger">{v}</Typography.Text> : '—',
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_: unknown, doc) => (
        <Button
          size="small"
          type="text"
          danger
          icon={<DeleteOutlined />}
          aria-label={`删除 ${doc.filename}`}
          onClick={() => removeDoc(doc)}
        >
          删除
        </Button>
      ),
    },
  ];

  return (
    <AppShell active="kb">
      <div className="page-scroll">
        <div className="page">
          <header className="page-head">
            <div>
              <h1 className="page-title">知识库</h1>
              <p className="page-sub">
                按主题建立多个知识库；专家助手绑定知识库后，回答时会自动检索并引用来源。
              </p>
            </div>
            <div className="page-head-actions">
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新建知识库
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

          <Row gutter={[16, 16]} align="top">
            <Col xs={24} lg={8} xl={7}>
              <Card
                title="我的知识库"
                size="small"
                loading={basesLoading && bases.length === 0}
                extra={
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    共 {bases.length} 个
                  </Typography.Text>
                }
              >
                {bases.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="还没有知识库"
                  >
                    <Button type="primary" size="small" onClick={openCreate}>
                      新建知识库
                    </Button>
                  </Empty>
                ) : (
                  <List
                    dataSource={bases}
                    rowKey="id"
                    split={false}
                    renderItem={(base) => {
                      const activeRow = base.id === selectedId;
                      return (
                        <List.Item
                          onClick={() => setSelectedId(base.id)}
                          style={{
                            cursor: 'pointer',
                            padding: '10px 12px',
                            borderRadius: 8,
                            background: activeRow ? 'rgba(0, 176, 123, 0.1)' : undefined,
                          }}
                          actions={[
                            <Button
                              key="rename"
                              type="text"
                              size="small"
                              onClick={(e) => {
                                e.stopPropagation();
                                openRename(base);
                              }}
                            >
                              重命名
                            </Button>,
                            <Button
                              key="delete"
                              type="text"
                              size="small"
                              danger
                              icon={<DeleteOutlined />}
                              aria-label={`删除知识库 ${base.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                removeBase(base);
                              }}
                            />,
                          ]}
                        >
                          <List.Item.Meta
                            title={
                              <Typography.Text strong={activeRow}>{base.name}</Typography.Text>
                            }
                            description={
                              <Space size={4} wrap>
                                {baseStatusTag(base)}
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  {base.docCount} 篇 · {formatBytes(base.totalBytes)}
                                </Typography.Text>
                              </Space>
                            }
                          />
                        </List.Item>
                      );
                    }}
                  />
                )}
              </Card>
            </Col>

            <Col xs={24} lg={16} xl={17}>
              <Card
                size="small"
                title={
                  selected ? (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{selected.name}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                        {selected.description || '未填写简介'}
                      </Typography.Text>
                    </Space>
                  ) : (
                    '文档'
                  )
                }
                extra={
                  selected ? (
                    <Upload
                      accept={ACCEPT}
                      showUploadList={false}
                      multiple={false}
                      disabled={uploading}
                      beforeUpload={(file) => {
                        void upload(file as File);
                        // 手动上传：阻止 antd 自己发请求。
                        return false;
                      }}
                    >
                      <Button type="primary" icon={<InboxOutlined />} loading={uploading}>
                        {uploading ? '上传中…' : '上传文档'}
                      </Button>
                    </Upload>
                  ) : null
                }
              >
                {selected ? (
                  <>
                    <Space size={8} wrap style={{ marginBottom: 12 }}>
                      <Tag color="success">{selected.readyCount} 就绪</Tag>
                      {selected.pendingCount > 0 ? (
                        <Tag color="processing">{selected.pendingCount} 摄取中</Tag>
                      ) : null}
                      {selected.failedCount > 0 ? (
                        <Tag color="error">{selected.failedCount} 失败</Tag>
                      ) : null}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {selected.chunkCount} 个切片 · 占用 {formatBytes(selected.totalBytes)}
                      </Typography.Text>
                    </Space>

                    <Table<KbDocDto>
                      rowKey="id"
                      size="small"
                      loading={docsLoading}
                      columns={columns}
                      dataSource={docs}
                      scroll={{ x: 720 }}
                      pagination={{ pageSize: 20, hideOnSinglePage: true }}
                      locale={{
                        emptyText: (
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description="还没有文档，上传后自动解析并向量化"
                          />
                        ),
                      }}
                    />

                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      支持 txt / md / csv / docx / xlsx / pdf；摄取期间每 2.5 秒自动刷新。
                    </Typography.Text>
                  </>
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="选择或新建一个知识库后管理文档"
                  />
                )}
              </Card>
            </Col>
          </Row>
        </div>
      </div>

      <Modal
        open={modalState !== null}
        title={modalState?.mode === 'rename' ? '重命名知识库' : '新建知识库'}
        okText={modalState?.mode === 'rename' ? '保存' : '创建'}
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submitModal()}
        onCancel={() => {
          if (!saving) setModalState(null);
        }}
        destroyOnHidden
      >
        {/* 每次打开都重新挂载表单，初值来自当前弹窗状态，避免残留上一次的输入。 */}
        <Form<BaseFormValues>
          key={modalState?.mode === 'rename' ? `rename:${modalState.base?.id}` : 'create'}
          form={form}
          layout="vertical"
          requiredMark={false}
          disabled={saving}
          // 关闭弹窗时销毁字段并丢弃取值；否则 useForm 的 store 会跨次保留，下次新建会带出上次输入。
          preserve={false}
          initialValues={{
            name: modalState?.base?.name ?? '',
            description: modalState?.base?.description ?? '',
          }}
        >
          <Form.Item
            label="名称"
            name="name"
            rules={[
              { required: true, whitespace: true, message: '请输入知识库名称' },
              { max: 60, message: '名称不能超过 60 个字' },
            ]}
          >
            <Input placeholder="如：合同模板库" maxLength={60} autoFocus />
          </Form.Item>
          <Form.Item
            label="简介"
            name="description"
            rules={[{ max: 500, message: '简介不能超过 500 个字' }]}
          >
            <Input.TextArea
              rows={3}
              maxLength={500}
              showCount
              placeholder="这个知识库存放哪些资料（可选）"
            />
          </Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
