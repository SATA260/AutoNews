import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSettings, updateSettingsFile } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('config loader and comment-preserving writer', () => {
  it('updates nested settings while preserving YAML comments', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-cfg-'));
    tempDirs.push(tmpDir);
    const settingsPath = path.join(tmpDir, 'settings.yaml');
    await fs.copyFile(path.join(REPO_ROOT, 'config', 'settings.yaml'), settingsPath);

    const updated = await updateSettingsFile(settingsPath, {
      ai: {
        stages: {
          polish: {
            model: 'gemini-3.8-flash-medium',
          },
        },
      },
      publish: {
        mode: 'auto',
      },
    });

    expect(updated.ai.stages.polish.model).toBe('gemini-3.8-flash-medium');
    expect(updated.publish.mode).toBe('auto');

    const rawAfter = await fs.readFile(settingsPath, 'utf8');
    expect(rawAfter).toContain('# 每期条数 N 不在全局设默认值');
    expect(rawAfter).toContain('# 强制开启 B 站平台 AI 生成内容声明标识');

    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.ai.stages.polish.model).toBe('gemini-3.8-flash-medium');
  });

  it('rejects invalid patch without modifying disk file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-cfg-err-'));
    tempDirs.push(tmpDir);
    const settingsPath = path.join(tmpDir, 'settings.yaml');
    await fs.copyFile(path.join(REPO_ROOT, 'config', 'settings.yaml'), settingsPath);
    const before = await fs.readFile(settingsPath, 'utf8');

    await expect(
      updateSettingsFile(settingsPath, {
        web: { port: 99999 },
      }),
    ).rejects.toThrow(/更新配置校验失败/);

    const after = await fs.readFile(settingsPath, 'utf8');
    expect(after).toBe(before);
  });
});
