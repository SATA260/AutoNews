import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type DoctorCheckItem, type DoctorReport, DoctorReportSchema } from '@aidaily/contracts';
import { execa } from 'execa';
import { chromium } from 'playwright';
import { getModelRouteNames } from '../config/model-connections.js';
import type { CoreContext } from '../context.js';
import { resolveChromiumExecutablePath } from '../media/compositor.js';
import { resolveBiliupExecutable } from '../publish/bilibili.js';

const MIN_DISK_FREE_BYTES = 1024 * 1024 * 1024;
const DOCTOR_CACHE_TTL_MS = 10 * 60 * 1000;
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

/** 环境自检的缓存控制选项 */
export interface DoctorOptions {
  /** 为 true 时优先返回有效期内且配置未变更的缓存结果 */
  useCache?: boolean;
  /** 为 true 时立即清空旧缓存并强制重新执行全部检查 */
  forceRefresh?: boolean;
}

/** 批量预热或刷新模型列表的选项 */
export interface WarmModelRoutesOptions {
  /** 仅加载指定的调用方式名称列表；不传则加载当前全部可用调用方式 */
  routes?: string[];
  /** 为 true 时忽略已有缓存，强制重新向工具或服务查询模型列表 */
  forceRefresh?: boolean;
}

/** 同步读取模型列表内存缓存时的快照结构 */
export interface CachedModelRoutesSnapshot {
  /** 单调递增的模型缓存修订号，供前端识别快照新旧顺序 */
  revision: number;
  /** 当前已成功查询且未过期的调用方式模型列表 */
  modelsByCli: Record<string, string[]>;
  /** 各调用方式当前配置的短摘要标识 */
  routeCacheKeys: Record<string, string>;
}

/** 按需预热或强制刷新模型列表后的返回结果 */
export interface WarmModelRoutesResult {
  /** 单调递增的模型缓存修订号，供前端避免旧快照覆盖新结果 */
  revision: number;
  /** 当前已成功缓存且与最新配置一致的调用方式模型列表 */
  modelsByCli: Record<string, string[]>;
  /** 本次请求中查询失败的调用方式名称及对应错误说明 */
  errorsByCli: Record<string, string>;
}

/** 系统运维与诊断服务接口 */
export interface SystemService {
  /** 检查 Node 版本、命令行工具、浏览器、语音合成接口、磁盘空间与配置可用性 */
  doctor(opts?: DoctorOptions): Promise<DoctorReport>;
  /** 同步读取当前仍然有效的环境自检缓存副本；无有效缓存时返回 null */
  getCachedDoctor(): DoctorReport | null;
  /** 列出当前配置的阶段模型调用方式 */
  getModelRoutes(): string[];
  /** 返回各调用方式当前配置的短摘要标识，供前端识别配置变更 */
  getRouteCacheKeys(): Record<string, string>;
  /** 查询指定调用方式支持的模型列表 */
  listModels(cli: string): Promise<string[]>;
  /** 同步读取当前配置下已缓存的各调用方式模型列表 */
  getCachedModelsByRoute(): Record<string, string[]>;
  /** 同步读取带修订号与配置摘要的模型缓存完整快照 */
  getCachedModelsSnapshot(): CachedModelRoutesSnapshot;
  /** 按需并发查询并缓存指定调用方式的模型列表，失败项单独记录错误而不写入空列表缓存 */
  warmModelRoutes(opts?: WarmModelRoutesOptions): Promise<WarmModelRoutesResult>;
}

/** 计算字节或文本数据的 SHA-256 十六进制摘要 */
function sha256Hex(raw: string | Uint8Array): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** 深拷贝环境自检报告对象，防止外部调用方修改缓存内部数组或字段 */
function cloneDoctorReport(report: DoctorReport): DoctorReport {
  return {
    ok: report.ok,
    checkedAt: report.checkedAt,
    checks: report.checks.map((item) => ({ ...item })),
  };
}

/** 安全读取基准目录内小文件的内容摘要，文件不存在、越界或不可读时返回 null */
function hashScopedFileContent(baseDir: string, relFile?: string): string | null {
  if (!relFile) {
    return null;
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relFile);
  if (!resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)) {
    return null;
  }
  try {
    const stat = fsSync.lstatSync(resolvedTarget);
    if (!stat.isFile()) {
      return null;
    }
    const content = fsSync.readFileSync(resolvedTarget);
    return sha256Hex(content);
  } catch {
    return null;
  }
}

/** 生成单个模型调用方式的配置与凭据内容指纹，配置或密钥内容变化时指纹立即改变 */
function computeRouteFingerprint(ctx: CoreContext, cliName: string): string {
  const providers = ctx.settings.ai.providers;
  if (providers && Object.hasOwn(providers, cliName)) {
    const provider = providers[cliName];
    const envDigest = provider?.apiKeyEnv ? sha256Hex(process.env[provider.apiKeyEnv] ?? '') : null;
    const fileDigest = hashScopedFileContent(ctx.paths.secretsDir, provider?.apiKeyFile);
    return sha256Hex(JSON.stringify({ kind: 'api', provider, envDigest, fileDigest }));
  }
  const cliCfg = Object.hasOwn(ctx.settings.clis, cliName) ? ctx.settings.clis[cliName] : undefined;
  return sha256Hex(JSON.stringify({ kind: 'cli', cliCfg }));
}

/** 生成环境自检依赖项的整体配置与凭据指纹，相关工具或凭据内容变更时自动使旧自检缓存失效 */
function computeDoctorFingerprint(ctx: CoreContext): string {
  const llmClis = Array.from(new Set(Object.values(ctx.settings.ai.stages).map((s) => s.cli)));
  const llmFingerprints = llmClis.map((name) => [name, computeRouteFingerprint(ctx, name)]);
  const biliCliName = ctx.settings.publish.bilibili.cli;
  const biliCliCfg = Object.hasOwn(ctx.settings.clis, biliCliName)
    ? ctx.settings.clis[biliCliName]
    : undefined;
  const cookieDigest = hashScopedFileContent(
    ctx.paths.rootDir,
    ctx.settings.publish.bilibili.cookieFile,
  );

  return sha256Hex(
    JSON.stringify({
      sourcesCount: ctx.sources.length,
      llmFingerprints,
      biliCliName,
      biliCliCfg,
      cookieFile: ctx.settings.publish.bilibili.cookieFile,
      cookieDigest,
      tts: ctx.settings.tts,
    }),
  );
}

/** 执行基础版本探测命令，返回是否可执行及首行版本信息 */
async function probeBinaryVersion(
  bin: string,
  args: string[] = ['-version'],
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await execa(bin, args, { timeout: 5000, reject: false });
    if (res.exitCode !== 0) {
      return {
        ok: false,
        detail: `${bin} 返回异常退出码 ${String(res.exitCode)}: ${(res.stderr || res.stdout).trim().slice(0, 120)}`,
      };
    }
    const firstLine = (res.stdout || res.stderr).split(/\r?\n/)[0]?.trim() || '可用';
    return { ok: true, detail: `${bin}: ${firstLine}` };
  } catch (err) {
    return {
      ok: false,
      detail: `无法运行 ${bin}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 并发执行全部环境健康检查并按固定顺序汇总诊断报告 */
async function executeDoctorChecks(ctx: CoreContext): Promise<DoctorReport> {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  const nodeCheck: DoctorCheckItem = {
    name: 'node',
    ok: nodeMajor >= 24,
    detail:
      nodeMajor >= 24
        ? `Node.js v${process.versions.node}`
        : `Node.js v${process.versions.node} 低于最低要求（>= 24）`,
    required: true,
  };

  let dbCheck: DoctorCheckItem;
  try {
    ctx.db.prepare('SELECT 1 AS ok').get();
    dbCheck = {
      name: 'config_and_db',
      ok: true,
      detail: `配置有效（已载入 ${ctx.sources.length} 个信源，数据库正常）`,
      required: true,
    };
  } catch (err) {
    dbCheck = {
      name: 'config_and_db',
      ok: false,
      detail: `数据库或配置检查失败: ${err instanceof Error ? err.message : String(err)}`,
      required: true,
    };
  }

  const llmClis = Array.from(new Set(Object.values(ctx.settings.ai.stages).map((s) => s.cli)));
  const llmChecksPromise = Promise.all(
    llmClis.map(async (cliName): Promise<DoctorCheckItem> => {
      const providers = ctx.settings.ai.providers;
      const provider =
        providers && Object.hasOwn(providers, cliName) ? providers[cliName] : undefined;
      const checkName = provider ? `api:${cliName}` : `cli:${cliName}`;
      try {
        const cliHealth = provider
          ? await ctx.modelApi.health(provider)
          : await ctx.bridge.health(cliName);
        return {
          name: checkName,
          ok: cliHealth.ok,
          detail: cliHealth.detail,
          required: true,
        };
      } catch (err) {
        return {
          name: checkName,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          required: true,
        };
      }
    }),
  );

  const ffmpegCheckPromise = probeBinaryVersion('ffmpeg', ['-version']).then(
    (probe): DoctorCheckItem => ({
      name: 'ffmpeg',
      ok: probe.ok,
      detail: probe.detail,
      required: true,
    }),
  );

  const ffprobeCheckPromise = probeBinaryVersion('ffprobe', ['-version']).then(
    (probe): DoctorCheckItem => ({
      name: 'ffprobe',
      ok: probe.ok,
      detail: probe.detail,
      required: true,
    }),
  );

  const chromiumCheckPromise = (async (): Promise<DoctorCheckItem> => {
    try {
      const resolvedFallback = await resolveChromiumExecutablePath();
      const candidatePath = resolvedFallback ?? chromium.executablePath();
      const exists = Boolean(candidatePath && fsSync.existsSync(candidatePath));
      return {
        name: 'playwright_chromium',
        ok: exists,
        detail: exists
          ? `Chromium 就绪: ${candidatePath}`
          : '未检测到 Playwright Chromium，请执行 npx playwright install chromium',
        required: true,
      };
    } catch (err) {
      return {
        name: 'playwright_chromium',
        ok: false,
        detail: `检查 Chromium 失败: ${err instanceof Error ? err.message : String(err)}`,
        required: true,
      };
    }
  })();

  const biliCheckPromise = (async (): Promise<DoctorCheckItem> => {
    const biliCliName = ctx.settings.publish.bilibili.cli;
    const biliCliCfg = Object.hasOwn(ctx.settings.clis, biliCliName)
      ? ctx.settings.clis[biliCliName]
      : undefined;
    const biliBin = resolveBiliupExecutable(biliCliCfg?.bin ?? biliCliName);
    const biliProbe = await probeBinaryVersion(biliBin, ['--version']);
    const resolvedRoot = path.resolve(ctx.paths.rootDir);
    const cookiePath = path.resolve(resolvedRoot, ctx.settings.publish.bilibili.cookieFile);
    const cookieInsideRoot = cookiePath.startsWith(`${resolvedRoot}${path.sep}`);
    const hasCookie = cookieInsideRoot && fsSync.existsSync(cookiePath);
    return {
      name: 'biliup',
      ok: biliProbe.ok,
      detail: biliProbe.ok
        ? !cookieInsideRoot
          ? `${biliProbe.detail}（警告：Cookie 路径超出项目根目录）`
          : `${biliProbe.detail}（${hasCookie ? `凭据存在: ${ctx.settings.publish.bilibili.cookieFile}` : '尚未扫码登录，请运行 aidaily bili login'}）`
        : biliProbe.detail,
      required: false,
    };
  })();

  const ttsCheckPromise = (async (): Promise<DoctorCheckItem> => {
    const checkName = `tts:${ctx.settings.tts.provider}`;
    try {
      const ttsHealth = await ctx.tts.healthcheck();
      return {
        name: checkName,
        ok: ttsHealth.ok,
        detail: ttsHealth.detail,
        required: true,
      };
    } catch (err) {
      return {
        name: checkName,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        required: true,
      };
    }
  })();

  const diskCheckPromise = (async (): Promise<DoctorCheckItem> => {
    try {
      const stat = await fs.statfs(ctx.paths.storageDir);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      const freeGiB = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);
      const ok = freeBytes >= MIN_DISK_FREE_BYTES;
      return {
        name: 'disk_space',
        ok,
        detail: ok
          ? `存储分区可用空间 ${freeGiB} GiB`
          : `存储分区可用空间仅剩 ${freeGiB} GiB，低于建议的 1.00 GiB，请清理 storage/runs`,
        required: true,
      };
    } catch (err) {
      return {
        name: 'disk_space',
        ok: false,
        detail: `读取磁盘空间失败: ${err instanceof Error ? err.message : String(err)}`,
        required: true,
      };
    }
  })();

  const [llmChecks, ffmpegCheck, ffprobeCheck, chromiumCheck, biliCheck, ttsCheck, diskCheck] =
    await Promise.all([
      llmChecksPromise,
      ffmpegCheckPromise,
      ffprobeCheckPromise,
      chromiumCheckPromise,
      biliCheckPromise,
      ttsCheckPromise,
      diskCheckPromise,
    ]);

  const checks: DoctorCheckItem[] = [
    nodeCheck,
    dbCheck,
    ...llmChecks,
    ffmpegCheck,
    ffprobeCheck,
    chromiumCheck,
    biliCheck,
    ttsCheck,
    diskCheck,
  ];
  const overallOk = checks.filter((c) => c.required).every((c) => c.ok);
  return DoctorReportSchema.parse({
    ok: overallOk,
    checkedAt: ctx.now().toISOString(),
    checks,
  });
}

/** 创建系统环境诊断与模型列表查询服务实例 */
export function createSystemService(ctx: CoreContext): SystemService {
  let doctorCache: { fingerprint: string; expiresAt: number; report: DoctorReport } | null = null;
  let doctorInFlight: {
    seq: number;
    fingerprint: string;
    promise: Promise<DoctorReport>;
  } | null = null;
  let doctorSeq = 0;

  let modelCacheRevision = 0;
  const modelCache = new Map<
    string,
    { fingerprint: string; expiresAt: number; models: string[] }
  >();
  const modelInFlight = new Map<
    string,
    { seq: number; fingerprint: string; promise: Promise<string[]> }
  >();
  const modelSeq = new Map<string, number>();

  /** 直接调用底层命令行或 HTTP 适配器拉取模型列表 */
  const fetchRawModels = async (cli: string): Promise<string[]> => {
    const providers = ctx.settings.ai.providers;
    const provider = providers && Object.hasOwn(providers, cli) ? providers[cli] : undefined;
    return provider ? ctx.modelApi.listModels(provider) : ctx.bridge.listModels(cli);
  };

  /** 清理已从配置中移除、指纹已变更或已过期的调用方式缓存条目，发生清理时推进修订号 */
  const pruneInvalidModelCache = (activeRoutes: string[]): void => {
    const activeSet = new Set(activeRoutes);
    const nowMs = ctx.now().getTime();
    let mutated = false;
    for (const [key, entry] of modelCache.entries()) {
      if (
        !activeSet.has(key) ||
        entry.fingerprint !== computeRouteFingerprint(ctx, key) ||
        nowMs >= entry.expiresAt
      ) {
        modelCache.delete(key);
        mutated = true;
      }
    }
    if (mutated) {
      modelCacheRevision += 1;
    }
  };

  /** 启动新一轮单调用方式模型查询并登记在途请求，仅在成功且仍属最新序号时写入缓存 */
  const startModelFetch = (cli: string): Promise<string[]> => {
    const startFp = computeRouteFingerprint(ctx, cli);
    const nextSeq = (modelSeq.get(cli) ?? 0) + 1;
    modelSeq.set(cli, nextSeq);

    const task = fetchRawModels(cli).then((models) => {
      const latestRoutes = new Set(getModelRouteNames(ctx.settings));
      if (
        latestRoutes.has(cli) &&
        modelSeq.get(cli) === nextSeq &&
        computeRouteFingerprint(ctx, cli) === startFp
      ) {
        modelCache.set(cli, {
          fingerprint: startFp,
          expiresAt: ctx.now().getTime() + MODEL_CACHE_TTL_MS,
          models: [...models],
        });
        modelCacheRevision += 1;
      }
      return [...models];
    });

    const flightEntry = { seq: nextSeq, fingerprint: startFp, promise: task };
    modelInFlight.set(cli, flightEntry);
    void task
      .finally(() => {
        if (modelInFlight.get(cli) === flightEntry) {
          modelInFlight.delete(cli);
        }
      })
      .catch(() => undefined);

    return task;
  };

  /** 跟随同一调用方式的最新一代在途请求直至彻底收敛，防止被新请求顶替后提前读取空缓存 */
  const awaitLatestRouteSettlement = async (
    cli: string,
    initialPromise: Promise<string[]>,
    errorsByCli: Record<string, string>,
  ): Promise<void> => {
    let currentPromise = initialPromise;
    for (let guard = 0; guard < 8; guard += 1) {
      try {
        await currentPromise;
        const newerFlight = modelInFlight.get(cli);
        if (newerFlight && newerFlight.promise !== currentPromise) {
          currentPromise = newerFlight.promise;
          continue;
        }
        const activeRoutes = getModelRouteNames(ctx.settings);
        if (!activeRoutes.includes(cli)) {
          return;
        }
        const latestFp = computeRouteFingerprint(ctx, cli);
        const settled = modelCache.get(cli);
        if (!settled || settled.fingerprint !== latestFp) {
          currentPromise = startModelFetch(cli);
          continue;
        }
        return;
      } catch (err) {
        const newerFlight = modelInFlight.get(cli);
        if (newerFlight && newerFlight.promise !== currentPromise) {
          currentPromise = newerFlight.promise;
          continue;
        }
        errorsByCli[cli] = err instanceof Error ? err.message : String(err);
        return;
      }
    }
  };

  return {
    /** 同步获取未过期且与当前配置指纹一致的自检报告深拷贝副本 */
    getCachedDoctor(): DoctorReport | null {
      if (!doctorCache) {
        return null;
      }
      const currentFp = computeDoctorFingerprint(ctx);
      if (doctorCache.fingerprint !== currentFp || ctx.now().getTime() >= doctorCache.expiresAt) {
        return null;
      }
      return cloneDoctorReport(doctorCache.report);
    },

    /** 全面检查项目运行所需的本地外部工具、磁盘空间及核心配置健康状况 */
    async doctor(opts?: DoctorOptions): Promise<DoctorReport> {
      if (opts?.forceRefresh) {
        doctorCache = null;
      }

      const useCache = Boolean(opts?.useCache) && !opts?.forceRefresh;
      while (useCache) {
        const cached = this.getCachedDoctor();
        if (cached) {
          return cached;
        }
        const currentFp = computeDoctorFingerprint(ctx);
        const activeFlight = doctorInFlight;
        if (!activeFlight || activeFlight.fingerprint !== currentFp) {
          break;
        }
        try {
          const report = await activeFlight.promise;
          if (doctorInFlight && doctorInFlight !== activeFlight) {
            continue;
          }
          return cloneDoctorReport(report);
        } catch (err) {
          if (doctorInFlight && doctorInFlight !== activeFlight) {
            continue;
          }
          throw err;
        }
      }

      const startFp = computeDoctorFingerprint(ctx);
      const seq = ++doctorSeq;
      const promise = executeDoctorChecks(ctx).then((report) => {
        if (seq === doctorSeq && computeDoctorFingerprint(ctx) === startFp) {
          doctorCache = {
            fingerprint: startFp,
            expiresAt: ctx.now().getTime() + DOCTOR_CACHE_TTL_MS,
            report: cloneDoctorReport(report),
          };
        }
        return report;
      });

      const flight = { seq, fingerprint: startFp, promise };
      doctorInFlight = flight;
      try {
        const report = await promise;
        return cloneDoctorReport(report);
      } finally {
        if (doctorInFlight === flight) {
          doctorInFlight = null;
        }
      }
    },

    /** 返回用于编辑阶段的本机命令和 HTTP 连接名称 */
    getModelRoutes(): string[] {
      return getModelRouteNames(ctx.settings);
    },

    /** 返回每个可用调用方式的配置短摘要标识，不含任何敏感明文 */
    getRouteCacheKeys(): Record<string, string> {
      const routes = getModelRouteNames(ctx.settings);
      const out: Record<string, string> = {};
      for (const cli of routes) {
        out[cli] = computeRouteFingerprint(ctx, cli).slice(0, 16);
      }
      return out;
    },

    /** 查询本机工具或 HTTP 服务的模型清单，登记在途请求并在成功后同步更新内存缓存 */
    async listModels(cli: string): Promise<string[]> {
      return startModelFetch(cli);
    },

    /** 同步返回当前配置下已缓存且未过期的模型列表映射 */
    getCachedModelsByRoute(): Record<string, string[]> {
      const routes = getModelRouteNames(ctx.settings);
      pruneInvalidModelCache(routes);

      const result: Record<string, string[]> = {};
      for (const cli of routes) {
        const entry = modelCache.get(cli);
        if (entry) {
          result[cli] = [...entry.models];
        }
      }
      return result;
    },

    /** 同步读取包含递增修订号、已缓存模型列表与配置短摘要的快照 */
    getCachedModelsSnapshot(): CachedModelRoutesSnapshot {
      const modelsByCli = this.getCachedModelsByRoute();
      const routeCacheKeys = this.getRouteCacheKeys();
      return {
        revision: modelCacheRevision,
        modelsByCli,
        routeCacheKeys,
      };
    },

    /** 并发预热或强制刷新调用方式的模型列表，等待最新一代在途请求完成且绝不将失败写入缓存 */
    async warmModelRoutes(opts?: WarmModelRoutesOptions): Promise<WarmModelRoutesResult> {
      const allRoutes = getModelRouteNames(ctx.settings);
      pruneInvalidModelCache(allRoutes);

      const requestedSet = opts?.routes ? new Set(opts.routes) : null;
      const targets = requestedSet
        ? allRoutes.filter((route) => requestedSet.has(route))
        : allRoutes;
      const forceRefresh = Boolean(opts?.forceRefresh);
      const errorsByCli: Record<string, string> = {};

      await Promise.all(
        targets.map(async (cli) => {
          if (!forceRefresh) {
            const currentFp = computeRouteFingerprint(ctx, cli);
            const cached = modelCache.get(cli);
            if (
              cached &&
              cached.fingerprint === currentFp &&
              ctx.now().getTime() < cached.expiresAt
            ) {
              return;
            }
            const activeFlight = modelInFlight.get(cli);
            if (activeFlight && activeFlight.fingerprint === currentFp) {
              await awaitLatestRouteSettlement(cli, activeFlight.promise, errorsByCli);
              return;
            }
          }

          const startedTask = startModelFetch(cli);
          await awaitLatestRouteSettlement(cli, startedTask, errorsByCli);
        }),
      );

      return {
        revision: modelCacheRevision,
        modelsByCli: this.getCachedModelsByRoute(),
        errorsByCli,
      };
    },
  };
}
