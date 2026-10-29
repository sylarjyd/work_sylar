'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Empty, Modal, Space, Tag, Tree, Typography } from 'antd';
import type { SkillDto } from '@ai-office/shared';
import {
  SKILL_MD_KEY,
  buildSkillTree,
  defaultExpandedKeys,
  flattenSkillTree,
  formatSkillFileSize,
  type SkillTreeNode,
} from './skill-tree';

export interface SkillDetailDialogProps {
  open: boolean;
  skill: SkillDto | null;
  onClose: () => void;
  /** 下载包内文件；SKILL.md 不走这里（正文已入库）。 */
  onDownloadFile?: (skill: SkillDto, path: string) => void;
  /** 底部额外操作（如「编辑」），由各端按权限注入。 */
  extra?: ReactNode;
}

/**
 * 技能详情：左侧目录树（SKILL.md + 包内文件），右侧查看正文或下载文件。
 * 两端共用一套交互，避免运营端与客户端对同一份技能给出不同理解。
 */
export function SkillDetailDialog({
  open,
  skill,
  onClose,
  onDownloadFile,
  extra,
}: SkillDetailDialogProps) {
  const tree = useMemo(() => (skill ? buildSkillTree(skill.files) : []), [skill]);
  const flat = useMemo(() => flattenSkillTree(tree), [tree]);
  const [selected, setSelected] = useState<string>(SKILL_MD_KEY);
  const [expanded, setExpanded] = useState<string[]>([]);

  // 换技能时重置选中与展开：否则会停留在上一份技能的路径上。
  useEffect(() => {
    setSelected(SKILL_MD_KEY);
    setExpanded(defaultExpandedKeys(tree));
  }, [tree]);

  const current: SkillTreeNode | undefined = flat.find((node) => node.key === selected);
  const isSkillMd = !current || current.key === SKILL_MD_KEY;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={
        <Space>
          {extra}
          <Button onClick={onClose}>关闭</Button>
        </Space>
      }
      width={880}
      title={
        skill ? (
          <Space size={8} wrap>
            <Typography.Text strong>{skill.name}</Typography.Text>
            <Tag>{skill.slug}</Tag>
            {skill.scope === 'public' ? <Tag color="green">公共</Tag> : <Tag>个人</Tag>}
            {skill.source === 'upload' ? <Tag color="purple">技能包</Tag> : null}
            {skill.version ? <Tag color="blue">v{skill.version}</Tag> : null}
          </Space>
        ) : (
          '技能详情'
        )
      }
    >
      {!skill ? null : (
        <div style={{ display: 'flex', gap: 16, minHeight: 420 }}>
          <div
            style={{
              width: 280,
              flex: '0 0 280px',
              borderRight: '1px solid #f0f0f0',
              paddingRight: 12,
              maxHeight: 520,
              overflow: 'auto',
            }}
          >
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
            {skill.files.length === 0 ? (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
                该技能没有附带文件，只有 SKILL.md。
              </Typography.Paragraph>
            ) : null}
          </div>

          <div style={{ flex: 1, minWidth: 0, maxHeight: 520, overflow: 'auto' }}>
            {isSkillMd ? (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Space size={6}>
                  <Typography.Text strong>SKILL.md</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    会拼进系统提示词
                  </Typography.Text>
                </Space>
                <Typography.Paragraph style={{ marginBottom: 0 }}>
                  {skill.description || '（无简介）'}
                </Typography.Paragraph>
                <Space size={4} wrap>
                  {skill.license ? <Tag>License: {skill.license}</Tag> : null}
                  {skill.allowedTools.length > 0 ? (
                    <Tag>allowed-tools: {skill.allowedTools.join(' ')}</Tag>
                  ) : null}
                </Space>
                <Typography.Paragraph
                  style={{
                    whiteSpace: 'pre-wrap',
                    background: '#fafafa',
                    borderRadius: 6,
                    padding: 12,
                    marginBottom: 0,
                  }}
                >
                  {skill.content}
                </Typography.Paragraph>
              </Space>
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Space size={6} wrap>
                  <Typography.Text strong>{current?.path}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {formatSkillFileSize(current?.size ?? 0)}
                  </Typography.Text>
                </Space>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  包内文件不会自动进提示词，运行时由模型按需读取；也可以直接下载查看。
                </Typography.Paragraph>
                <Button
                  onClick={() => {
                    if (current) onDownloadFile?.(skill, current.path);
                  }}
                  disabled={!onDownloadFile}
                >
                  下载文件
                </Button>
              </Space>
            )}
          </div>
        </div>
      )}
      {skill && skill.files.length === 0 && !isSkillMd ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可展示的文件" />
      ) : null}
    </Modal>
  );
}
