import type { AdminModelDto, ModelCapability } from '@ai-office/shared';

/** 未绑定厂商的模型（来自环境变量兜底目录）用特殊值筛选。 */
export const UNBOUND_PROVIDER = '__none__';

export interface AdminModelFilter {
  /** 'all' 不过滤；具体厂商 id 精确匹配；UNBOUND_PROVIDER 只看未绑定。 */
  providerId: string;
  capability: 'all' | ModelCapability;
}

/** 厂商与能力分类叠加过滤；顺序无关，先厂商后能力，纯函数便于单测。 */
export function filterAdminModels(
  models: AdminModelDto[],
  filter: AdminModelFilter,
): AdminModelDto[] {
  const byProvider =
    filter.providerId === 'all'
      ? models
      : models.filter((m) =>
          filter.providerId === UNBOUND_PROVIDER ? !m.providerId : m.providerId === filter.providerId,
        );
  const capability = filter.capability;
  return capability === 'all'
    ? byProvider
    : byProvider.filter((m) => m.capabilities.includes(capability));
}
