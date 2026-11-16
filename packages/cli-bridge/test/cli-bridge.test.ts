import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type CallRecord,
  CliAuthError,
  CliBridge,
  CliExitError,
  CliNotFoundError,
  CliOutputError,
  CliTimeoutError,
  PromptTooLargeError,
} from '../src/index.js';

const FIXTURE_AGY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-agy.mjs',
);

const tempDirs: string[] = [];
const envSnapshot = { ...process.env };

afterEach(async () => {
  process.env = { ...envSnapshot };
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeBridge(
  extraConfigs?: Record<
    string,
    {
      adapter: 'agy' | 'generic';
      bin: string;
      extraArgs?: string[];
      argsTemplate?: string[];
      parse?: 'json' | 'text' | `json-field:${string}`;
    }
  >,
  calls: CallRecord[] = [],
): Promise<{ bridge: CliBridge; tmpDir: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-bridge-'));
  tempDirs.push(tmpDir);
  const bridge = new CliBridge({
    configs: {
      agy: {
        adapter: 'agy',
        bin: FIXTURE_AGY,
        extraArgs: [],
      },
      ...extraConfigs,
    },
    tmpDir,
    retryDelaysMs: [10, 20],
    logCall: (rec) => {
      calls.push(rec);
    },
  });
  return { bridge, tmpDir };
}

describe('@aidaily/cli-bridge', () => {
  it('invokes agy with structured schema, records usage, and cleans isolated workDir', async () => {
    await fs.chmod(FIXTURE_AGY, 0o755);
    const calls: CallRecord[] = [];
    const { bridge, tmpDir } = await makeBridge(undefined, calls);

    const schema = z.object({ summary: z.string(), ok: z.boolean() });
    const res = await bridge.invoke({
      cli: 'agy',
      prompt: '总结这段新闻',
      schema,
      model: 'gemini-3.8-flash-high',
      timeoutMs: 10_000,
      retries: 1,
      meta: { runId: 'run-1', stage: 'summarize' },
    });

    expect(res.data).toEqual({ summary: '测试摘要输出', ok: true });
    expect(res.attempts).toBe(1);
    expect(res.conversationId).toBe('conv-ok-123');
    expect(res.usage).toEqual({ inputTokens: 15322, outputTokens: 61 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('ok');
    expect(calls[0]?.stage).toBe('summarize');

    const workEntries = await fs.readdir(path.join(tmpDir, 'cli-bridge'));
    expect(workEntries).toHaveLength(0);
  });

  it('retries CliOutputError with validation hint appended to prompt', async () => {
    await fs.chmod(FIXTURE_AGY, 0o755);
    process.env.FAKE_AGY_MODE = 'bad_schema_once';
    process.env.FAKE_AGY_RESPONSE_JSON = JSON.stringify({
      summary: '重试成功',
      ok: true,
    });
    process.env.FAKE_AGY_ECHO_PROMPT_IN_SUMMARY = '1';

    const calls: CallRecord[] = [];
    const { bridge } = await makeBridge(undefined, calls);

    const schema = z.object({
      summary: z.string(),
      ok: z.boolean(),
      seenRetryHint: z.boolean().optional(),
    });
    const res = await bridge.invoke({
      cli: 'agy',
      prompt: '输出总结',
      schema,
      timeoutMs: 10_000,
      retries: 2,
    });

    expect(res.attempts).toBe(2);
    expect(res.data.seenRetryHint).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.status).toBe('bad_output');
    expect(calls[1]?.status).toBe('ok');
  });

  it('retries bad JSON until retries exhausted and throws CliOutputError', async () => {
    await fs.chmod(FIXTURE_AGY, 0o755);
    process.env.FAKE_AGY_MODE = 'bad_json_once';
    const calls: CallRecord[] = [];
    const { bridge } = await makeBridge(undefined, calls);

    await expect(
      bridge.invoke({
        cli: 'agy',
        prompt: 'hello',
        schema: z.object({ summary: z.string() }),
        timeoutMs: 10_000,
        retries: 0,
      }),
    ).rejects.toBeInstanceOf(CliOutputError);
    expect(calls).toHaveLength(1);
  });

  it('kills timed-out process and retries up to limit', async () => {
    await fs.chmod(FIXTURE_AGY, 0o755);
    process.env.FAKE_AGY_MODE = 'timeout';
    const calls: CallRecord[] = [];
    const { bridge } = await makeBridge(undefined, calls);

    await expect(
      bridge.invoke({
        cli: 'agy',
        prompt: 'slow',
        timeoutMs: 120,
        retries: 1,
      }),
    ).rejects.toBeInstanceOf(CliTimeoutError);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.status === 'timeout')).toBe(true);
  });

  it('does not retry CliAuthError, CliNotFoundError, or PromptTooLargeError', async () => {
    await fs.chmod(FIXTURE_AGY, 0o755);
    process.env.FAKE_AGY_MODE = 'auth_error';
    const calls: CallRecord[] = [];
    const { bridge } = await makeBridge(
      {
        missing: { adapter: 'agy', bin: '/nonexistent/binary/aidaily-xyz', extraArgs: [] },
      },
      calls,
    );

    await expect(
      bridge.invoke({ cli: 'agy', prompt: 'hi', timeoutMs: 5_000, retries: 3 }),
    ).rejects.toBeInstanceOf(CliAuthError);
    expect(calls).toHaveLength(1);

    await expect(
      bridge.invoke({ cli: 'missing', prompt: 'hi', timeoutMs: 5_000, retries: 3 }),
    ).rejects.toBeInstanceOf(CliNotFoundError);

    await expect(
      bridge.invoke({
        cli: 'agy',
        prompt: 'x'.repeat(410_000),
        timeoutMs: 5_000,
        retries: 3,
      }),
    ).rejects.toBeInstanceOf(PromptTooLargeError);
  });

  it('throws CliExitError on non-zero exit / non-SUCCESS envelope', async () => {
    await fs.chmod(FIXTURE_AGY, 0o755);
    process.env.FAKE_AGY_MODE = 'exit_error';
    const { bridge } = await makeBridge();

    await expect(
      bridge.invoke({ cli: 'agy', prompt: 'hi', timeoutMs: 5_000, retries: 0 }),
    ).rejects.toBeInstanceOf(CliExitError);
  });

  it('aborts an in-flight call immediately via AbortSignal', async () => {
    await fs.chmod(FIXTURE_AGY, 0o755);
    process.env.FAKE_AGY_MODE = 'timeout';
    const { bridge } = await makeBridge();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);

    await expect(
      bridge.invoke({
        cli: 'agy',
        prompt: 'abort me',
        timeoutMs: 10_000,
        retries: 2,
        signal: ac.signal,
      }),
    ).rejects.toThrow();
  });

  it('parses agy models stripping ANSI spinners and checks health', async () => {
    await fs.chmod(FIXTURE_AGY, 0o755);
    const { bridge } = await makeBridge();

    const health = await bridge.health('agy');
    expect(health.ok).toBe(true);

    const models = await bridge.listModels('agy');
    expect(models).toEqual([
      'gemini-4-carbon-high',
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
    ]);
  });

  it('supports generic adapter and raw exec()', async () => {
    const { bridge } = await makeBridge({
      echoJson: {
        adapter: 'generic',
        bin: process.execPath,
        extraArgs: [],
        argsTemplate: [
          '-e',
          'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({result:{msg:process.argv[2]}}));',
          '{out}',
          '{prompt}',
        ],
        parse: 'json-field:result',
      },
    });

    const out = await bridge.invoke({
      cli: 'echoJson',
      prompt: '你好世界',
      schema: z.object({ msg: z.string() }),
      timeoutMs: 5_000,
      retries: 0,
    });
    expect(out.data).toEqual({ msg: '你好世界' });

    const raw = await bridge.exec('echoJson', ['-e', 'process.stdout.write("pong")'], {
      timeoutMs: 5_000,
    });
    expect(raw.stdout).toBe('pong');
  });
});
