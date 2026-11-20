import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCore,
  editSourcesFile,
  loadSettings,
  loadSources,
  resolveRenderTheme,
  updateSettingsFile,
  updateSourcesFile,
} from '../src/index.js';

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

  it('preserves comments in sources.yaml and rejects malformed YAML documents', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-cfg-src-'));
    tempDirs.push(tmpDir);
    const sourcesPath = path.join(tmpDir, 'sources.yaml');
    await fs.copyFile(path.join(REPO_ROOT, 'config', 'sources.yaml'), sourcesPath);

    const sources = await loadSources(sourcesPath);
    const updatedSources = sources.map((s) =>
      s.id === 'openai-news' ? { ...s, enabled: false } : s,
    );
    await updateSourcesFile(sourcesPath, updatedSources);

    const rawSourcesAfter = await fs.readFile(sourcesPath, 'utf8');
    expect(rawSourcesAfter).toContain('# pool: primary 每次都抓');
    const reloadedSources = await loadSources(sourcesPath);
    expect(reloadedSources.find((s) => s.id === 'openai-news')?.enabled).toBe(false);

    const badYaml = path.join(tmpDir, 'broken.yaml');
    await fs.writeFile(badYaml, 'version: 1\n  bad_indent: [1, 2', 'utf8');
    await expect(updateSettingsFile(badYaml, { timezone: 'UTC' })).rejects.toThrow(/语法错误/);
  });

  it('defaults video template theme to dark and validates light/dark theme settings', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-cfg-theme-'));
    tempDirs.push(tmpDir);
    const settingsPath = path.join(tmpDir, 'settings.yaml');
    await fs.copyFile(path.join(REPO_ROOT, 'config', 'settings.yaml'), settingsPath);

    const loaded = await loadSettings(settingsPath);
    expect(loaded.render.theme).toBe('dark');
    expect(resolveRenderTheme(loaded.render)).toBe('dark');
    expect(resolveRenderTheme({})).toBe('dark');
    expect(resolveRenderTheme({ theme: 'light' })).toBe('light');

    const switched = await updateSettingsFile(settingsPath, {
      render: { theme: 'light' },
    });
    expect(switched.render.theme).toBe('light');
    expect(resolveRenderTheme(switched.render)).toBe('light');

    await expect(
      updateSettingsFile(settingsPath, {
        render: { theme: 'sepia' as unknown as 'dark' },
      }),
    ).rejects.toThrow(/更新配置校验失败/);
  });

  it('supports atomic toggleSource and recovers stale cross-process lock files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-cfg-lock-'));
    tempDirs.push(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'config'), { recursive: true });
    await fs.copyFile(
      path.join(REPO_ROOT, 'config', 'settings.yaml'),
      path.join(tmpDir, 'config', 'settings.yaml'),
    );
    await fs.copyFile(
      path.join(REPO_ROOT, 'config', 'sources.yaml'),
      path.join(tmpDir, 'config', 'sources.yaml'),
    );

    const sourcesPath = path.join(tmpDir, 'config', 'sources.yaml');
    // 先写入一个模拟已死进程残留的锁文件，后续修改应能安全识别并回收
    await fs.writeFile(
      `${sourcesPath}.lock`,
      JSON.stringify({ pid: 999999, token: 'dead-token', createdAt: 1000 }),
      'utf8',
    );

    const core = await createCore({ rootDir: tmpDir });
    try {
      const initialSources = core.config.getSources();
      const firstId = initialSources[0]?.id;
      const secondId = initialSources[1]?.id;
      expect(firstId && secondId).toBeTruthy();
      if (!firstId || !secondId) {
        throw new Error('缺少示例信源');
      }

      // 并发切换两个不同信源，两者都必须保留各自的改动而不互相覆盖
      await Promise.all([
        core.config.toggleSource(firstId, false),
        core.config.toggleSource(secondId, false),
      ]);

      const reloaded = await loadSources(sourcesPath);
      expect(reloaded.find((s) => s.id === firstId)?.enabled).toBe(false);
      expect(reloaded.find((s) => s.id === secondId)?.enabled).toBe(false);

      // 直接并发调用 editSourcesFile 也必须全部保留
      await Promise.all([
        editSourcesFile(sourcesPath, (list) =>
          list.map((s) => (s.id === firstId ? { ...s, enabled: true } : s)),
        ),
        editSourcesFile(sourcesPath, (list) =>
          list.map((s) => (s.id === secondId ? { ...s, enabled: true } : s)),
        ),
      ]);
      const restored = await loadSources(sourcesPath);
      expect(restored.find((s) => s.id === firstId)?.enabled).toBe(true);
      expect(restored.find((s) => s.id === secondId)?.enabled).toBe(true);
      await expect(fs.stat(`${sourcesPath}.lock`)).rejects.toThrow();
    } finally {
      await core.close();
    }
  });
});
