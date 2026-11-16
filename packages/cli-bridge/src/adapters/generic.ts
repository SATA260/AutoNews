import fs from 'node:fs/promises';
import path from 'node:path';
import { type CliConfig, zodToJsonSchema } from '@aidaily/contracts';
import { CliExitError } from '../errors.js';
import { runSubprocess } from '../exec.js';
import { extractJsonFromText } from '../json.js';
import type { AdapterCommand, AdapterParsedOutput, CliAdapter, InvokeRequest } from '../types.js';

function getByDotPath(obj: unknown, dotPath: string): unknown {
  let curr: unknown = obj;
  for (const key of dotPath.split('.')) {
    if (typeof curr !== 'object' || curr === null || !(key in curr)) {
      return undefined;
    }
    curr = (curr as Record<string, unknown>)[key];
  }
  return curr;
}

export const genericAdapter: CliAdapter = {
  id: 'generic',

  async buildCommand(
    req: InvokeRequest<unknown>,
    cfg: CliConfig,
    workDir: string,
  ): Promise<AdapterCommand> {
    const schemaFile = path.join(workDir, 'schema.json');
    const outFile = path.join(workDir, 'output.txt');

    if (req.schema) {
      await fs.writeFile(schemaFile, JSON.stringify(zodToJsonSchema(req.schema), null, 2));
    }

    const template = cfg.argsTemplate ?? ['{prompt}'];
    const args = template.map((token) =>
      token
        .replaceAll('{prompt}', req.prompt)
        .replaceAll('{model}', req.model ?? '')
        .replaceAll('{schemaFile}', req.schema ? schemaFile : '')
        .replaceAll('{out}', outFile),
    );

    if (cfg.extraArgs.length > 0) {
      args.push(...cfg.extraArgs);
    }

    const usesOutFile = template.some((t) => t.includes('{out}'));
    return {
      bin: cfg.bin,
      args,
      outFile: usesOutFile ? outFile : undefined,
    };
  },

  parse(
    stdout: string,
    stderr: string,
    exitCode: number,
    ctx: { hasSchema: boolean; outFileContent?: string },
    parseMode: string = 'json',
  ): AdapterParsedOutput {
    if (exitCode !== 0) {
      throw new CliExitError(
        `命令退出异常 (code=${exitCode}): ${stderr.trim() || stdout.trim().slice(0, 300)}`,
        exitCode,
        stderr,
      );
    }

    const raw = ctx.outFileContent ?? stdout;
    if (parseMode === 'text') {
      return { payload: raw.trim() };
    }

    const json = extractJsonFromText(raw);
    if (parseMode.startsWith('json-field:')) {
      const fieldPath = parseMode.slice('json-field:'.length);
      return { payload: getByDotPath(json, fieldPath) };
    }
    return { payload: json };
  },

  async healthcheck(cfg: CliConfig): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await runSubprocess(cfg.bin, ['--help'], { timeoutMs: 10_000 });
      return {
        ok: res.exitCode === 0,
        detail:
          res.exitCode === 0 ? `CLI 可用 (${cfg.bin})` : `退出码 ${res.exitCode}: ${res.stderr}`,
      };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

export function createConfiguredGenericAdapter(cfg: CliConfig): CliAdapter {
  const parseMode = cfg.parse ?? 'json';
  return {
    id: 'generic',
    buildCommand: (req, config, workDir) => genericAdapter.buildCommand(req, config, workDir),
    parse: (stdout, stderr, exitCode, ctx) =>
      (
        genericAdapter.parse as (
          s: string,
          e: string,
          c: number,
          ctx: { hasSchema: boolean; outFileContent?: string },
          mode: string,
        ) => AdapterParsedOutput
      )(stdout, stderr, exitCode, ctx, parseMode),
    healthcheck: (config) => genericAdapter.healthcheck(config),
  };
}
