'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Input, Modal, Select, Space, Spin, Tag, Typography } from 'antd';
import type { SkillDto } from '@ai-office/shared';

export interface SkillTestModelOption {
  value: string;
  label: string;
}

export interface SkillTestDialogProps {
  open: boolean;
  skill: SkillDto | null;
  models: SkillTestModelOption[];
  onClose: () => void;
  /** 用真实模型跑一次只注入该技能的对话。 */
  onRun: (model: string | undefined, prompt: string) => Promise<{ reply: string; model: string }>;
}

const DEFAULT_PROMPT = '请按技能要求完成一个示例任务，并在回答末尾说明你用了技能里的哪几步。';

/** 技能测试：选模型 + 任务描述，跑一次真实对话看提示词是否生效。 */
export function SkillTestDialog({ open, skill, models, onClose, onRun }: SkillTestDialogProps) {
  const [model, setModel] = useState<string | undefined>(undefined);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ reply: string; model: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setModel(models[0]?.value);
    setPrompt(DEFAULT_PROMPT);
    setResult(null);
    setError('');
    setRunning(false);
  }, [open, models, skill]);

  async function run(): Promise<void> {
    if (running) return;
    if (!prompt.trim()) {
      setError('任务描述不能为空');
      return;
    }
    setRunning(true);
    setError('');
    setResult(null);
    try {
      setResult(await onRun(model, prompt.trim()));
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      const map: Record<string, string> = {
        invalid_prompt: '任务描述不能为空，且不超过 2000 字',
        runtime_unavailable: '运行时不可用，请确认 agent-runtime 已启动',
        runtime_timeout: '模型超时未返回，可换个模型再试',
        runtime_failed: '本次测试失败，请查看运行日志',
        skill_not_found: '技能不存在或无权访问',
      };
      setError(map[code] ?? '测试失败，请稍后重试');
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal
      open={open}
      title={`测试技能 · ${skill?.name ?? ''}`}
      width={720}
      onCancel={running ? undefined : onClose}
      footer={
        <Space>
          <Button onClick={onClose} disabled={running}>
            关闭
          </Button>
          <Button type="primary" loading={running} onClick={() => void run()}>
            运行测试
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div>
          <Typography.Text type="secondary">模型</Typography.Text>
          <Select
            style={{ width: '100%', marginTop: 4 }}
            value={model}
            onChange={setModel}
            placeholder={models.length === 0 ? '暂无可用模型' : '选择模型'}
            disabled={running || models.length === 0}
            options={models}
            showSearch
            optionFilterProp="label"
          />
        </div>
        <div>
          <Typography.Text type="secondary">任务描述（会作为用户消息发给模型，只注入这一个技能）</Typography.Text>
          <Input.TextArea
            style={{ marginTop: 4 }}
            rows={4}
            maxLength={2000}
            showCount
            value={prompt}
            disabled={running}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        {error ? <Alert type="error" showIcon message={error} /> : null}

        {running ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <Spin tip="模型运行中…" />
          </div>
        ) : result ? (
          <div>
            <Space size={6} style={{ marginBottom: 6 }}>
              <Typography.Text strong>模型回答</Typography.Text>
              <Tag>{result.model}</Tag>
            </Space>
            <Typography.Paragraph
              style={{
                whiteSpace: 'pre-wrap',
                background: '#fafafa',
                borderRadius: 6,
                padding: 12,
                maxHeight: 320,
                overflow: 'auto',
                marginBottom: 0,
              }}
            >
              {result.reply}
            </Typography.Paragraph>
          </div>
        ) : (
          !error && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有测试结果" />
        )}
      </Space>
    </Modal>
  );
}
