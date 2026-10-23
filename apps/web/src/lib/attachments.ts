import {
  ATTACHMENT_MAX_PER_MESSAGE,
  ATTACHMENT_SPECS,
  attachmentKindFor,
  attachmentKindLabel,
  type AttachmentKind,
  type ModelModality,
} from '@ai-office/shared';

export interface AcceptedFile {
  file: File;
  kind: AttachmentKind;
}

export type FileRejectReason = 'unsupported_type' | 'file_too_large' | 'too_many';

export interface RejectedFile {
  filename: string;
  reason: FileRejectReason;
}

/**
 * 客户端预检只是即时反馈：服务端会按同一份 ATTACHMENT_SPECS 再校验一次。
 * 已达数量上限时不再接收后续文件，避免用户看到一堆必然失败的 chip。
 */
export function checkFiles(
  files: readonly File[],
  existingCount: number,
): { accepted: AcceptedFile[]; rejected: RejectedFile[] } {
  const accepted: AcceptedFile[] = [];
  const rejected: RejectedFile[] = [];
  for (const file of files) {
    if (existingCount + accepted.length >= ATTACHMENT_MAX_PER_MESSAGE) {
      rejected.push({ filename: file.name, reason: 'too_many' });
      continue;
    }
    const kind = attachmentKindFor(file.name, file.type);
    if (!kind) {
      rejected.push({ filename: file.name, reason: 'unsupported_type' });
      continue;
    }
    if (file.size > ATTACHMENT_SPECS[kind].maxBytes) {
      rejected.push({ filename: file.name, reason: 'file_too_large' });
      continue;
    }
    accepted.push({ file, kind });
  }
  return { accepted, rejected };
}

export function fileRejectText(rejected: RejectedFile): string {
  switch (rejected.reason) {
    case 'too_many':
      return `最多一次发送 ${ATTACHMENT_MAX_PER_MESSAGE} 个附件，已忽略「${rejected.filename}」`;
    case 'unsupported_type':
      return `不支持「${rejected.filename}」的文件类型`;
    case 'file_too_large':
      return `「${rejected.filename}」超出大小上限`;
  }
}

/** 返回当前模型不支持的附件类别；空数组表示全部可用。 */
export function unsupportedModalities(
  kinds: readonly AttachmentKind[],
  supported: readonly ModelModality[] | undefined,
): AttachmentKind[] {
  if (!supported) return [];
  return [...new Set(kinds)].filter((kind) => !supported.includes(kind));
}

export function modalityWarning(kinds: readonly AttachmentKind[]): string {
  const labels = [...new Set(kinds)].map(attachmentKindLabel).join('、');
  return `当前模型不支持${labels}输入，请切换模型或移除对应附件。`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
