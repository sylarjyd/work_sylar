import { ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { ConnectorDto, McpToolInfo } from '@ai-office/shared';
import { PrismaService } from '../db/prisma.service';
import { encrypt, decrypt } from './crypto';

const VALIDATE_TIMEOUT_MS = 20_000;

export interface ConnectorRuntimeConfig {
  runtimeUrl?: string;
  runtimeToken?: string;
  fetchImpl?: typeof fetch;
}

export interface ConnectorInput {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ConnectorPatch {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

/** runtime 视角的完整连接器（含解密 env）。 */
export interface EnabledConnector {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

/** runtime 校验失败（spawn/握手/协议错）：由调用方映射为 400。 */
export class ValidateFailedError extends Error {}

@Injectable()
export class ConnectorService {
  private readonly logger = new Logger(ConnectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly cfg: ConnectorRuntimeConfig = {},
  ) {}

  async create(input: ConnectorInput, tenantId: string, createdBy: string): Promise<ConnectorDto> {
    const dup = await this.prisma.connector.findFirst({ where: { tenantId, name: input.name } });
    if (dup) throw new ConflictException('duplicate_name');
    const args = input.args ?? [];
    const env = input.env ?? {};
    const tools = await this.validateRuntime(input.command, args, env);
    try {
      const row = await this.prisma.connector.create({
        data: {
          tenantId,
          name: input.name,
          command: input.command,
          args,
          envEncrypted: encrypt(JSON.stringify(env)),
          enabled: true,
          toolCount: tools.length,
          lastValidatedAt: new Date(),
          createdBy,
        },
      });
      return toDto(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('duplicate_name');
      throw e;
    }
  }

  async list(tenantId: string): Promise<ConnectorDto[]> {
    const rows = await this.prisma.connector.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDto);
  }

  async update(id: string, tenantId: string, patch: ConnectorPatch): Promise<ConnectorDto> {
    const row = await this.prisma.connector.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('connector_not_found');

    if (patch.name !== undefined && patch.name !== row.name) {
      const dup = await this.prisma.connector.findFirst({ where: { tenantId, name: patch.name } });
      if (dup) throw new ConflictException('duplicate_name');
    }

    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.enabled !== undefined) data.enabled = patch.enabled;

    // 仅当「会改变运行行为」的字段变化时才重新校验（切 enabled 不必）。
    const touchesRuntime =
      patch.command !== undefined || patch.args !== undefined || patch.env !== undefined;
    if (touchesRuntime) {
      const command = patch.command ?? row.command;
      const args = patch.args ?? readStringArray(row.args);
      const env =
        patch.env ?? (JSON.parse(decrypt(row.envEncrypted)) as Record<string, string>);
      const tools = await this.validateRuntime(command, args, env);
      data.command = command;
      data.args = args;
      if (patch.env !== undefined) data.envEncrypted = encrypt(JSON.stringify(env));
      data.toolCount = tools.length;
      data.lastValidatedAt = new Date();
    }

    try {
      const updated = await this.prisma.connector.update({ where: { id }, data });
      return toDto(updated);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('duplicate_name');
      throw e;
    }
  }

  async remove(id: string, tenantId: string): Promise<void> {
    const row = await this.prisma.connector.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!row) throw new NotFoundException('connector_not_found');
    await this.prisma.connector.delete({ where: { id } });
  }

  /** 供 runtime 拉取：启用连接器，env 解密。 */
  async listEnabled(tenantId: string): Promise<EnabledConnector[]> {
    const rows = await this.prisma.connector.findMany({ where: { tenantId, enabled: true } });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      command: r.command,
      args: readStringArray(r.args),
      env: JSON.parse(decrypt(r.envEncrypted)) as Record<string, string>,
      enabled: r.enabled,
    }));
  }

  private async validateRuntime(
    command: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<McpToolInfo[]> {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const base = this.cfg.runtimeUrl ?? process.env.AGENT_RUNTIME_URL ?? 'http://localhost:4001';
    const token = this.cfg.runtimeToken ?? process.env.AGENT_RUNTIME_TOKEN;
    let res: Response;
    try {
      res = await doFetch(`${base}/connectors/validate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-agent-runtime-token': token } : {}),
        },
        body: JSON.stringify({ command, args, env }),
        signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
      });
    } catch {
      throw new ValidateFailedError('runtime_unreachable');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new ValidateFailedError(`runtime_http_${res.status}`);
    }
    let data: { ok: boolean; tools?: McpToolInfo[]; error?: string };
    try {
      data = (await res.json()) as { ok: boolean; tools?: McpToolInfo[]; error?: string };
    } catch {
      throw new ValidateFailedError('invalid_response');
    }
    if (!data.ok) {
      // 不透传 runtime 原始错误：其内容可能回显 command/env，构成密钥泄露面，仅记服务端日志。
      this.logger.warn(`连接器校验失败：${data.error ?? 'unknown'}`);
      throw new ValidateFailedError('validate_failed');
    }
    return data.tools ?? [];
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

function readStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function toDto(row: {
  id: string;
  name: string;
  command: string;
  args: unknown;
  enabled: boolean;
  toolCount: number;
  lastValidatedAt: Date | null;
  createdAt: Date;
}): ConnectorDto {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    args: readStringArray(row.args),
    enabled: row.enabled,
    toolCount: row.toolCount,
    lastValidatedAt: row.lastValidatedAt ? row.lastValidatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
