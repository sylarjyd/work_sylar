import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AttachmentsService, MAX_RUN_ATTACHMENT_BYTES, type PreparedMessage } from './attachments.service';
import type { AttachmentStorage } from './attachments.storage';
import type { PrismaService } from '../db/prisma.service';

type Row = Record<string, any>;

function makeDb() {
  const attachments: Row[] = [];
  const client = {
    attachment: {
      create: async ({ data }: any) => {
        const row = {
          id: `a${attachments.length + 1}`,
          sessionId: null,
          messageId: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          ...data,
        };
        attachments.push(row);
        return row;
      },
      findMany: async ({ where }: any) =>
        attachments.filter(
          (a) =>
            where.id.in.includes(a.id) &&
            a.tenantId === where.tenantId &&
            a.userId === where.userId &&
            a.sessionId === where.sessionId &&
            a.messageId === where.messageId,
        ),
      findFirst: async ({ where }: any) =>
        attachments.find(
          (a) =>
            a.id === where.id &&
            (where.tenantId === undefined || a.tenantId === where.tenantId) &&
            (where.userId === undefined || a.userId === where.userId),
        ) ?? null,
      delete: async ({ where }: any) => {
        const i = attachments.findIndex((a) => a.id === where.id);
        if (i >= 0) attachments.splice(i, 1);
        return {};
      },
    },
  };
  return { attachments, prisma: client as unknown as PrismaService };
}

function makeStorage() {
  const objects = new Map<string, Buffer>();
  const deleted: string[] = [];
  const storage: AttachmentStorage = {
    putObject: async (key, body) => {
      objects.set(key, Buffer.from(body));
    },
    getObjectBuffer: async (key) => {
      const buf = objects.get(key);
      if (!buf) throw new Error('NoSuchKey');
      return buf;
    },
    deleteObject: async (key) => {
      deleted.push(key);
      objects.delete(key);
    },
  };
  return { storage, objects, deleted };
}

let ctx: ReturnType<typeof makeDb>;
let storageCtx: ReturnType<typeof makeStorage>;
let svc: AttachmentsService;

beforeEach(() => {
  ctx = makeDb();
  storageCtx = makeStorage();
  svc = new AttachmentsService(ctx.prisma, storageCtx.storage);
});

const textInput = (filename = 'note.txt', content = 'hello') => ({
  filename,
  kind: 'text' as const,
  mime: 'text/plain',
  size: Buffer.byteLength(content),
  buffer: Buffer.from(content),
});

describe('AttachmentsService', () => {
  it('create 落库并返回 DTO，存储 Key 带租户/用户隔离', async () => {
    const dto = await svc.create('t1', 'u1', textInput());

    expect(dto).toMatchObject({ kind: 'text', filename: 'note.txt', size: 5 });
    expect(ctx.attachments[0]).toMatchObject({ tenantId: 't1', userId: 'u1', mime: 'text/plain' });
    expect(ctx.attachments[0].storageKey).toMatch(/^attachments\/t1\/u1\/.+\/note\.txt$/);
    expect(storageCtx.objects.get(ctx.attachments[0].storageKey)?.toString()).toBe('hello');
    // DTO 不暴露存储 Key。
    expect(dto).not.toHaveProperty('storageKey');
  });

  it('create 对不支持的类型与超限大小直接拒绝，且不写存储', async () => {
    await expect(
      svc.create('t1', 'u1', { ...textInput('evil.html'), kind: 'text', mime: 'text/html' }),
    ).rejects.toThrow('unsupported_type');

    await expect(
      svc.create('t1', 'u1', { ...textInput(), size: 10 * 1024 * 1024 + 1 }),
    ).rejects.toThrow('file_too_large');

    expect(ctx.attachments).toHaveLength(0);
    expect(storageCtx.objects.size).toBe(0);
  });

  it('create 落库失败时删除已上传对象，避免孤儿文件', async () => {
    vi.spyOn(ctx.prisma.attachment as any, 'create').mockRejectedValueOnce(new Error('db down'));

    await expect(svc.create('t1', 'u1', textInput())).rejects.toThrow('db down');

    expect(storageCtx.deleted).toHaveLength(1);
    expect(storageCtx.objects.size).toBe(0);
  });

  it('listOwnedUnclaimed 去重后按入参顺序返回；缺失/已占用时报 404', async () => {
    const a1 = await svc.create('t1', 'u1', textInput('a.txt'));
    const a2 = await svc.create('t1', 'u1', textInput('b.png', 'x'));
    // 直接改写类型以模拟图片；分类以文件名/MIME 为准。
    ctx.attachments[1].mime = 'image/png';

    const out = await svc.listOwnedUnclaimed([a2.id, a1.id, a2.id], 't1', 'u1');
    expect(out.map((a) => a.id)).toEqual([a2.id, a1.id]);
    expect(out[0]).toMatchObject({ kind: 'image', filename: 'b.png' });

    await expect(svc.listOwnedUnclaimed([a1.id, 'missing'], 't1', 'u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.listOwnedUnclaimed([a1.id], 't2', 'u1')).rejects.toBeInstanceOf(NotFoundException);

    ctx.attachments[0].messageId = 'm1';
    await expect(svc.listOwnedUnclaimed([a1.id], 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('remove 拒绝已绑定消息的附件；未绑定时删对象与记录', async () => {
    const dto = await svc.create('t1', 'u1', textInput());
    ctx.attachments[0].messageId = 'm1';

    await expect(svc.remove(dto.id, 't1', 'u1')).rejects.toBeInstanceOf(ConflictException);
    expect(ctx.attachments).toHaveLength(1);

    ctx.attachments[0].messageId = null;
    await svc.remove(dto.id, 't1', 'u1');
    expect(storageCtx.deleted).toHaveLength(1);
    expect(ctx.attachments).toHaveLength(0);

    await expect(svc.remove(dto.id, 't1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getContent 校验归属并返回原始字节', async () => {
    const dto = await svc.create('t1', 'u1', textInput());

    await expect(svc.getContent(dto.id, 't2', 'u1')).rejects.toBeInstanceOf(NotFoundException);

    const content = await svc.getContent(dto.id, 't1', 'u1');
    expect(content).toMatchObject({ mime: 'text/plain', filename: 'note.txt' });
    expect(content.buffer.toString()).toBe('hello');
  });

  describe('hydrateForRun', () => {
    function message(id: string, size: number, content: string): PreparedMessage {
      return {
        role: 'user',
        content: 'hi',
        attachments: [
          {
            id,
            kind: 'text',
            filename: `${id}.txt`,
            mime: 'text/plain',
            size,
            storageKey: `key/${id}`,
          },
        ],
      };
    }

    it('最新消息附件完整携带，历史附件按预算降级为元数据', async () => {
      storageCtx.objects.set('key/new', Buffer.from('new'));
      storageCtx.objects.set('key/huge', Buffer.from('huge'));
      // 把历史附件声明为预算内放不下的大小：不应尝试读取对象。
      const huge = message('huge', MAX_RUN_ATTACHMENT_BYTES, 'huge');
      const latest = message('new', 3, 'new');

      const out = await svc.hydrateForRun([huge, { role: 'user', content: 'q', attachments: [] }, latest]);

      expect(out[0].attachments?.[0]).toMatchObject({ filename: 'huge.txt', size: MAX_RUN_ATTACHMENT_BYTES });
      expect(out[0].attachments?.[0]).not.toHaveProperty('data');
      expect(out[2].attachments?.[0].data).toBe(Buffer.from('new').toString('base64'));
      // 无附件消息不产生 attachments 字段，保持 wire 体积最小。
      expect(out[1]).not.toHaveProperty('attachments');
    });

    it('最新消息附件超出总预算时直接报错', async () => {
      const latest: PreparedMessage = {
        role: 'user',
        content: 'q',
        attachments: [
          message('a', MAX_RUN_ATTACHMENT_BYTES, '').attachments[0],
          message('b', 1, '').attachments[0],
        ],
      };
      await expect(svc.hydrateForRun([latest])).rejects.toThrow('attachments_too_large');
    });

    it('最新附件读取失败抛错；历史附件读取失败只保留元数据', async () => {
      await expect(svc.hydrateForRun([message('missing', 1, '')])).rejects.toThrow('NoSuchKey');

      storageCtx.objects.set('key/latest', Buffer.from('ok'));
      const out = await svc.hydrateForRun([
        message('missing', 1, ''),
        { role: 'user', content: 'q', attachments: [] },
        message('latest', 2, 'ok'),
      ]);
      expect(out[0].attachments?.[0]).not.toHaveProperty('data');
      expect(out[2].attachments?.[0].data).toBe(Buffer.from('ok').toString('base64'));
    });
  });
});
