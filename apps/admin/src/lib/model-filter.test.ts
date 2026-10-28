import { describe, expect, it } from 'vitest';
import type { AdminModelDto } from '@ai-office/shared';
import { filterAdminModels, UNBOUND_PROVIDER } from './model-filter';

function model(patch: Partial<AdminModelDto> & { model: string }): AdminModelDto {
  return {
    displayName: patch.model,
    providerId: 'p1',
    providerName: '厂商一',
    enabled: true,
    capabilities: ['chat'],
    modalities: ['text'],
    sortOrder: 0,
    inputMilliCreditsPer1k: 0,
    outputMilliCreditsPer1k: 0,
    isDefault: false,
    updatedAt: '2026-10-01T00:00:00Z',
    ...patch,
  };
}

const models = [
  model({ model: 'a' }),
  model({ model: 'b', providerId: 'p2', providerName: '厂商二' }),
  model({ model: 'c', providerId: null, providerName: null }),
  model({ model: 'emb', providerId: 'p2', capabilities: ['embedding'] }),
];

describe('filterAdminModels', () => {
  it('按厂商精确过滤', () => {
    const out = filterAdminModels(models, { providerId: 'p2', capability: 'all' });
    expect(out.map((m) => m.model)).toEqual(['b', 'emb']);
  });

  it('只看未绑定厂商的模型', () => {
    const out = filterAdminModels(models, { providerId: UNBOUND_PROVIDER, capability: 'all' });
    expect(out.map((m) => m.model)).toEqual(['c']);
  });

  it('厂商与能力分类叠加', () => {
    const out = filterAdminModels(models, { providerId: 'p2', capability: 'chat' });
    expect(out.map((m) => m.model)).toEqual(['b']);
  });

  it("'all' 返回原列表，未知厂商返回空", () => {
    expect(filterAdminModels(models, { providerId: 'all', capability: 'all' })).toHaveLength(4);
    expect(filterAdminModels(models, { providerId: 'missing', capability: 'all' })).toEqual([]);
  });
});
