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
  Segmented,
  Space,
  Tag,
  Typography,
} from 'antd';
import { BulbOutlined, PlusOutlined } from '@ant-design/icons';
import type { SkillDto, SkillInput } from '@ai-office/shared';
import { AppShell } from '../../components/app-shell';
import {
  createSkill,
  deleteSkill,
  getToken,
  isUnauthorized,
  listSkills,
  shareSkill,
  updateSkill,
} from '../../lib/api';
import { errorText } from '@ai-office/web-core';

const EMPTY_FORM: SkillInput = { name: '', description: '', content: '' };

type Filter = 'all' | 'mine' | 'public';

interface SkillForm extends SkillInput {
  id?: string;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/** 技能市场（用户侧）：公共技能人人可见；个人技能仅自己可见，可共享为公共。 */
export default function SkillsPage() {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [items, setItems] = useState<SkillDto[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [form, setForm] = useState<SkillForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loadSeq = useRef(0);
  const inFlight = useRef(false);

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
      if (form.id) await updateSkill(form.id, input);
      else await createSkill(input);
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
                把一套做法沉淀成技能，绑定到助手后会在执行任务时自动注入提示词。个人技能只有你能看到，共享后成为公共技能。
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
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={busy}
                onClick={() => setForm({ ...EMPTY_FORM })}
              >
                新建技能
              </Button>
            </Space>
          </header>

          {error ? <Alert type="error" showIcon message={error} /> : null}

          {loading ? (
            <Card loading />
          ) : visible.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                filter === 'mine' ? '还没有个人技能，点右上角新建' : '暂无技能'
              }
            >
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setForm({ ...EMPTY_FORM })}>
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
                        {item.scope === 'public' ? (
                          <Tag color="green">公共</Tag>
                        ) : (
                          <Tag>个人</Tag>
                        )}
                        {item.source === 'run' ? <Tag color="blue">任务总结</Tag> : null}
                      </Space>
                    }
                    extra={
                      item.owned && item.scope === 'personal' ? (
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
                          <Button size="small" disabled={busy} onClick={() => share(item)}>
                            共享
                          </Button>
                          <Button size="small" danger disabled={busy} onClick={() => remove(item)}>
                            删除
                          </Button>
                        </Space>
                      ) : item.owned ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          已共享
                        </Typography.Text>
                      ) : null
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
                      更新于 {formatTime(item.updatedAt)}
                    </Typography.Text>
                  </Card>
                </Col>
              ))}
            </Row>
          )}
        </div>
      </div>

      <Modal
        title={form?.id ? '编辑技能' : '新建技能'}
        open={form !== null}
        okText="保存"
        cancelText="取消"
        confirmLoading={busy}
        width={640}
        onOk={() => void save()}
        onCancel={() => {
          if (!busy) setForm(null);
        }}
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
                placeholder="如：竞品调研流程"
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
    </AppShell>
  );
}
