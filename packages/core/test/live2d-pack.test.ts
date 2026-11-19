import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderableIssue } from '@aidaily/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDailyDeckAdapter,
  resolveHostLive2dModelUrl,
  resolveMascotModelDirectory,
  resolveRenderLive2dPack,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** 创建隔离的临时目录并在测试结束后自动清理 */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('Live2D 双目录模型套组解析与缓存指纹', () => {
  it('默认优先解析全身动作版套组，并支持切换至仅表情版套组', async () => {
    expect(resolveRenderLive2dPack({})).toBe('fullbody');
    expect(resolveRenderLive2dPack({ live2dPack: 'expression' })).toBe('expression');

    for (const hostId of ['deepseek', 'gpt', 'claude', 'gemini'] as const) {
      const fullbodyUrl = await resolveHostLive2dModelUrl(REPO_ROOT, hostId, undefined, 'fullbody');
      expect(fullbodyUrl).toBe(`/__mascot_assets__/fullbody/${hostId}/${hostId}.model3.json`);

      const exprUrl = await resolveHostLive2dModelUrl(REPO_ROOT, hostId, undefined, 'expression');
      expect(exprUrl).toBe(`/__mascot_assets__/expression/${hostId}/${hostId}.model3.json`);
    }
  });

  it('当首选套组缺少某个角色时自动回退可用套组或历史平面目录', async () => {
    const tmpRoot = await makeTempDir('aidaily-live2d-fallback-');
    const exprDir = path.join(tmpRoot, 'assets', 'mascots', 'expression', 'claude');
    await fs.mkdir(exprDir, { recursive: true });
    await fs.writeFile(path.join(exprDir, 'claude.model3.json'), '{}', 'utf8');

    const resolvedFallback = await resolveHostLive2dModelUrl(
      tmpRoot,
      'claude',
      undefined,
      'fullbody',
    );
    expect(resolvedFallback).toBe('/__mascot_assets__/expression/claude/claude.model3.json');

    const legacyRoot = await makeTempDir('aidaily-live2d-legacy-');
    const legacyDir = path.join(legacyRoot, 'assets', 'mascots', 'gpt');
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, 'gpt.model3.json'), '{}', 'utf8');

    const resolvedLegacy = await resolveHostLive2dModelUrl(
      legacyRoot,
      'gpt',
      undefined,
      'fullbody',
    );
    expect(resolvedLegacy).toBe('/__mascot_assets__/gpt/gpt.model3.json');
  });

  it('缓存指纹严格绑定实际命中的模型子目录，修改模型文件或切换套组均会使指纹失效', async () => {
    const tmpRoot = await makeTempDir('aidaily-live2d-fp-');
    const mascotRoot = path.join(tmpRoot, 'assets', 'mascots');
    const fullDir = path.join(mascotRoot, 'fullbody', 'gemini');
    const exprDir = path.join(mascotRoot, 'expression', 'gemini');
    await fs.mkdir(fullDir, { recursive: true });
    await fs.mkdir(exprDir, { recursive: true });
    await fs.writeFile(path.join(fullDir, 'gemini.model3.json'), '{"v":1}', 'utf8');
    await fs.writeFile(path.join(exprDir, 'gemini.model3.json'), '{"v":"expr"}', 'utf8');

    // 安全路径解析防目录穿越验证
    const resolvedFull = await resolveMascotModelDirectory(
      mascotRoot,
      '/__mascot_assets__/fullbody/gemini/gemini.model3.json',
      'gemini',
    );
    expect(resolvedFull).toBe(fullDir);

    const traversalBlocked = await resolveMascotModelDirectory(
      mascotRoot,
      '/__mascot_assets__/fullbody/../../etc/passwd',
      'gemini',
    );
    expect(traversalBlocked).toBe(fullDir);

    const templateDir = path.join(REPO_ROOT, 'templates', 'daily-deck');
    const adapter = createDailyDeckAdapter();
    const baseIssue: RenderableIssue = {
      date: '2026-11-19',
      issueNumber: 'VOL.2026.11.19',
      hostId: 'gemini',
      bgmVolumeDb: -12,
      pagePaddingSec: 1,
      fps: 30,
      headline: '测试标题',
      leadSummary: '测试导语',
      intro: { narration: ['测试开场'], hostComment: '开场短评' },
      outro: { narration: ['测试结尾'], hostComment: '结尾短评', cta: '欢迎关注' },
      items: [],
    };

    const fpFull1 = await adapter.getAssetFingerprint?.({
      rootDir: tmpRoot,
      templateDir,
      issue: {
        ...baseIssue,
        hostLive2dModelUrl: '/__mascot_assets__/fullbody/gemini/gemini.model3.json',
      },
    });
    const fpExpr = await adapter.getAssetFingerprint?.({
      rootDir: tmpRoot,
      templateDir,
      issue: {
        ...baseIssue,
        hostLive2dModelUrl: '/__mascot_assets__/expression/gemini/gemini.model3.json',
      },
    });
    expect(fpFull1).toBeTruthy();
    expect(fpExpr).toBeTruthy();
    expect(fpFull1).not.toBe(fpExpr);

    // 更改全身版模型文件内容后，全身版指纹随之变化
    await fs.writeFile(path.join(fullDir, 'gemini.model3.json'), '{"v":2}', 'utf8');
    const fpFull2 = await adapter.getAssetFingerprint?.({
      rootDir: tmpRoot,
      templateDir,
      issue: {
        ...baseIssue,
        hostLive2dModelUrl: '/__mascot_assets__/fullbody/gemini/gemini.model3.json',
      },
    });
    expect(fpFull2).not.toBe(fpFull1);
  });
});
