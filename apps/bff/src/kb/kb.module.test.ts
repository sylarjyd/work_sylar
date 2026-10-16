import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../db/prisma.module';
import { KbModule } from './kb.module';
import { KbService } from './kb.service';

describe('KbModule DI', () => {
  it('模块可编译且 KbService 可解析（防接口类型构造参数漏 @Inject/@Optional）', async () => {
    const mod = await Test.createTestingModule({ imports: [PrismaModule, KbModule] }).compile();
    expect(mod.get(KbService)).toBeInstanceOf(KbService);
  });
});
