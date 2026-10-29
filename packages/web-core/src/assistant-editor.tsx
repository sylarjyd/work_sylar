'use client';

import { Checkbox, Col, Input, Popover, Row, Select, Space, Typography } from 'antd';
import {
  ASSISTANT_PERMISSION_MODES,
  ASSISTANT_PERMISSION_MODE_HINTS,
  ASSISTANT_PERMISSION_MODE_LABELS,
  ASSISTANT_SKILLS,
  type AssistantPermissionMode,
} from '@ai-office/shared';

export interface AssistantEditorValue {
  name: string;
  description: string;
  systemPrompt: string;
  permissionMode: AssistantPermissionMode;
  model: string;
  skills: string[];
  skillIds: string[];
  connectorIds: string[];
  kbIds: string[];
}

export interface AssistantEditorOption {
  value: string;
  label: string;
}

export interface AssistantEditorProps {
  value: AssistantEditorValue;
  onChange: (next: AssistantEditorValue) => void;
  disabled?: boolean;
  /** 默认模型选项；不传或 showModel=false 时隐藏该字段。 */
  modelOptions?: AssistantEditorOption[];
  skillOptions: AssistantEditorOption[];
  connectorOptions?: AssistantEditorOption[];
  kbOptions?: AssistantEditorOption[];
  showModel?: boolean;
  showConnectors?: boolean;
  showKb?: boolean;
}

/** 字段名 + 问号说明：解释默认收起，点击问号才展开。 */
function FieldLabel({ text, hint }: { text: string; hint?: string }) {
  if (!hint) return <Typography.Text>{text}</Typography.Text>;
  return (
    <Space size={4}>
      <Typography.Text>{text}</Typography.Text>
      <Popover
        trigger="click"
        placement="topLeft"
        title={text}
        content={<div style={{ maxWidth: 300, fontSize: 12, lineHeight: 1.6 }}>{hint}</div>}
      >
        <span className="assistant-field-hint" role="img" aria-label={`${text}说明`}>
          ?
        </span>
      </Popover>
    </Space>
  );
}

/**
 * 专家助手表单：运营端与客户端共用同一套字段顺序与样式，避免两端各写一份对不上。
 * 运营端的公共助手不涉及租户私有资源（默认模型/知识库/连接器），按开关隐藏。
 */
export function AssistantEditor({
  value,
  onChange,
  disabled = false,
  modelOptions = [],
  skillOptions,
  connectorOptions = [],
  kbOptions = [],
  showModel = true,
  showConnectors = true,
  showKb = true,
}: AssistantEditorProps) {
  const patch = (next: Partial<AssistantEditorValue>) => onChange({ ...value, ...next });

  return (
    <Row gutter={[16, 0]}>
      <Col xs={24} md={showModel ? 12 : 24}>
        <div className="admin-field">
          <Typography.Text>名称</Typography.Text>
          <Input
            value={value.name}
            maxLength={40}
            disabled={disabled}
            placeholder="如：合同审阅专家"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </div>
      </Col>
      {showModel ? (
        <Col xs={24} md={12}>
          <div className="admin-field">
            <Typography.Text>默认模型</Typography.Text>
            <Select
              style={{ width: '100%' }}
              value={value.model}
              disabled={disabled}
              onChange={(model: string) => patch({ model })}
              options={[{ value: '', label: '系统默认模型' }, ...modelOptions]}
            />
          </div>
        </Col>
      ) : null}

      <Col span={24}>
        <div className="admin-field">
          <Typography.Text>简介</Typography.Text>
          <Input.TextArea
            rows={3}
            value={value.description}
            maxLength={200}
            showCount
            disabled={disabled}
            placeholder="一句话说明这个专家助手擅长什么"
            onChange={(e) => patch({ description: e.target.value })}
          />
        </div>
      </Col>

      <Col xs={24} md={showKb ? 12 : 24}>
        <div className="admin-field">
          <FieldLabel
            text="权限模式"
            hint={ASSISTANT_PERMISSION_MODE_HINTS[value.permissionMode]}
          />
          <Select
            style={{ width: '100%' }}
            value={value.permissionMode}
            disabled={disabled}
            onChange={(permissionMode: AssistantPermissionMode) => patch({ permissionMode })}
            options={ASSISTANT_PERMISSION_MODES.map((mode) => ({
              value: mode,
              label: ASSISTANT_PERMISSION_MODE_LABELS[mode],
            }))}
          />
        </div>
      </Col>
      {showKb ? (
        <Col xs={24} md={12}>
          <div className="admin-field">
            <Typography.Text>知识库范围</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {value.kbIds.length === 0
                ? '未选择时检索全部知识库'
                : `仅检索已选的 ${value.kbIds.length} 个知识库`}
            </Typography.Text>
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              allowClear
              disabled={disabled || kbOptions.length === 0}
              value={value.kbIds}
              placeholder={kbOptions.length === 0 ? '知识库为空，可先到「知识库」页创建' : '选择要检索的知识库'}
              onChange={(kbIds: string[]) => patch({ kbIds })}
              options={kbOptions}
              optionFilterProp="label"
            />
          </div>
        </Col>
      ) : null}

      <Col span={24}>
        <div className="admin-field">
          <FieldLabel
            text="工具"
            hint="勾选后助手才能调用对应内置能力；未勾选的工具本会话不可用。技能市场里的技能不占工具名额。"
          />
          <div className="assistant-tool-grid">
            {ASSISTANT_SKILLS.map((tool) => (
              <Checkbox
                key={tool.key}
                checked={value.skills.includes(tool.key)}
                disabled={disabled}
                onChange={(e) =>
                  patch({
                    skills: e.target.checked
                      ? [...value.skills, tool.key]
                      : value.skills.filter((x) => x !== tool.key),
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
      </Col>

      <Col xs={24} md={showConnectors ? 12 : 24}>
        <div className="admin-field">
          <FieldLabel
            text="绑定技能"
            hint="技能内容会拼进系统提示词；不改变工具权限，工具仍由上面的「工具」开关决定。"
          />
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            allowClear
            disabled={disabled || skillOptions.length === 0}
            value={value.skillIds}
            placeholder={skillOptions.length === 0 ? '技能市场暂无可绑定技能' : '选择要绑定的技能'}
            onChange={(skillIds: string[]) => patch({ skillIds })}
            options={skillOptions}
            optionFilterProp="label"
          />
        </div>
      </Col>
      {showConnectors ? (
        <Col xs={24} md={12}>
          <div className="admin-field">
            <FieldLabel
              text="连接器"
              hint="只启用所选 MCP 连接器；不选时沿用会话/账号下已启用的连接器。"
            />
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              allowClear
              disabled={disabled}
              value={value.connectorIds}
              placeholder={
                connectorOptions.length === 0
                  ? '还没有启用的连接器，可先到「连接器」页添加'
                  : '选择要启用的连接器'
              }
              onChange={(connectorIds: string[]) => patch({ connectorIds })}
              options={connectorOptions}
              optionFilterProp="label"
            />
          </div>
        </Col>
      ) : null}

      <Col span={24}>
        <div className="admin-field">
          <Typography.Text>系统提示词</Typography.Text>
          <Input.TextArea
            rows={6}
            maxLength={8000}
            showCount
            value={value.systemPrompt}
            disabled={disabled}
            placeholder="描述专家助手的角色、目标、工作方式与输出要求。例如：你是资深合同审阅专家，逐条指出风险条款并给出修改建议…"
            onChange={(e) => patch({ systemPrompt: e.target.value })}
          />
        </div>
      </Col>
    </Row>
  );
}
