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

/** 系统运维与诊断服务接口 */
export interface SystemService {
  /** 检查 Node 版本、命令行工具、浏览器、语音合成接口、磁盘空间与配置可用性 */
  doctor(): Promise<DoctorReport>;
  /** 列出当前配置的阶段模型调用方式 */
  getModelRoutes(): string[];
  /** 查询指定调用方式支持的模型列表 */
  listModels(cli: string): Promise<string[]>;
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

/** 创建系统环境诊断与模型列表查询服务实例 */
export function createSystemService(ctx: CoreContext): SystemService {
  return {
    /** 全面检查项目运行所需的本地外部工具、磁盘空间及核心配置健康状况 */
    async doctor(): Promise<DoctorReport> {
      const checks: DoctorCheckItem[] = [];

      // 1. Node.js 版本（要求 >= 24）
      const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
      checks.push({
        name: 'node',
        ok: nodeMajor >= 24,
        detail:
          nodeMajor >= 24
            ? `Node.js v${process.versions.node}`
            : `Node.js v${process.versions.node} 低于最低要求（>= 24）`,
        required: true,
      });

      // 2. 配置与数据库读写检查
      try {
        ctx.db.prepare('SELECT 1 AS ok').get();
        checks.push({
          name: 'config_and_db',
          ok: true,
          detail: `配置有效（已载入 ${ctx.sources.length} 个信源，数据库正常）`,
          required: true,
        });
      } catch (err) {
        checks.push({
          name: 'config_and_db',
          ok: false,
          detail: `数据库或配置检查失败: ${err instanceof Error ? err.message : String(err)}`,
          required: true,
        });
      }

      // 检查各 AI 阶段正在使用的模型调用方式。
      const llmClis = Array.from(new Set(Object.values(ctx.settings.ai.stages).map((s) => s.cli)));
      for (const cliName of llmClis) {
        const providers = ctx.settings.ai.providers;
        const provider =
          providers && Object.hasOwn(providers, cliName) ? providers[cliName] : undefined;
        const checkName = provider ? `api:${cliName}` : `cli:${cliName}`;
        try {
          const cliHealth = provider
            ? await ctx.modelApi.health(provider)
            : await ctx.bridge.health(cliName);
          checks.push({
            name: checkName,
            ok: cliHealth.ok,
            detail: cliHealth.detail,
            required: true,
          });
        } catch (err) {
          checks.push({
            name: checkName,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
            required: true,
          });
        }
      }

      // 4. ffmpeg 与 ffprobe 检查
      const ffmpegProbe = await probeBinaryVersion('ffmpeg', ['-version']);
      checks.push({
        name: 'ffmpeg',
        ok: ffmpegProbe.ok,
        detail: ffmpegProbe.detail,
        required: true,
      });

      const ffprobeProbe = await probeBinaryVersion('ffprobe', ['-version']);
      checks.push({
        name: 'ffprobe',
        ok: ffprobeProbe.ok,
        detail: ffprobeProbe.detail,
        required: true,
      });

      // 5. Playwright Chromium 浏览器可执行文件检查
      try {
        const resolvedFallback = await resolveChromiumExecutablePath();
        const candidatePath = resolvedFallback ?? chromium.executablePath();
        const exists = Boolean(candidatePath && fsSync.existsSync(candidatePath));
        checks.push({
          name: 'playwright_chromium',
          ok: exists,
          detail: exists
            ? `Chromium 就绪: ${candidatePath}`
            : '未检测到 Playwright Chromium，请执行 npx playwright install chromium',
          required: true,
        });
      } catch (err) {
        checks.push({
          name: 'playwright_chromium',
          ok: false,
          detail: `检查 Chromium 失败: ${err instanceof Error ? err.message : String(err)}`,
          required: true,
        });
      }

      // 6. B 站投稿命令行工具与登录凭据检查
      const biliCliCfg = ctx.settings.clis[ctx.settings.publish.bilibili.cli];
      const biliBin = resolveBiliupExecutable(biliCliCfg?.bin ?? ctx.settings.publish.bilibili.cli);
      const biliProbe = await probeBinaryVersion(biliBin, ['--version']);
      const resolvedRoot = path.resolve(ctx.paths.rootDir);
      const cookiePath = path.resolve(resolvedRoot, ctx.settings.publish.bilibili.cookieFile);
      const cookieInsideRoot = cookiePath.startsWith(`${resolvedRoot}${path.sep}`);
      const hasCookie = cookieInsideRoot && fsSync.existsSync(cookiePath);
      checks.push({
        name: 'biliup',
        ok: biliProbe.ok,
        detail: biliProbe.ok
          ? !cookieInsideRoot
            ? `${biliProbe.detail}（警告：Cookie 路径超出项目根目录）`
            : `${biliProbe.detail}（${hasCookie ? `凭据存在: ${ctx.settings.publish.bilibili.cookieFile}` : '尚未扫码登录，请运行 aidaily bili login'}）`
          : biliProbe.detail,
        required: false,
      });

      // 7. 语音合成接口检查
      try {
        const ttsHealth = await ctx.tts.healthcheck();
        checks.push({
          name: `tts:${ctx.settings.tts.provider}`,
          ok: ttsHealth.ok,
          detail: ttsHealth.detail,
          required: true,
        });
      } catch (err) {
        checks.push({
          name: `tts:${ctx.settings.tts.provider}`,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          required: true,
        });
      }

      // 8. 存储目录剩余磁盘空间检查（至少保留 1 GiB）
      try {
        const stat = await fs.statfs(ctx.paths.storageDir);
        const freeBytes = Number(stat.bavail) * Number(stat.bsize);
        const freeGiB = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);
        const ok = freeBytes >= MIN_DISK_FREE_BYTES;
        checks.push({
          name: 'disk_space',
          ok,
          detail: ok
            ? `存储分区可用空间 ${freeGiB} GiB`
            : `存储分区可用空间仅剩 ${freeGiB} GiB，低于建议的 1.00 GiB，请清理 storage/runs`,
          required: true,
        });
      } catch (err) {
        checks.push({
          name: 'disk_space',
          ok: false,
          detail: `读取磁盘空间失败: ${err instanceof Error ? err.message : String(err)}`,
          required: true,
        });
      }

      const overallOk = checks.filter((c) => c.required).every((c) => c.ok);
      return DoctorReportSchema.parse({
        ok: overallOk,
        checkedAt: ctx.now().toISOString(),
        checks,
      });
    },

    /** 返回用于编辑阶段的本机命令和 HTTP 连接名称 */
    getModelRoutes(): string[] {
      return getModelRouteNames(ctx.settings);
    },

    /** 查询本机工具或 HTTP 服务的模型清单 */
    async listModels(cli: string): Promise<string[]> {
      const providers = ctx.settings.ai.providers;
      const provider = providers && Object.hasOwn(providers, cli) ? providers[cli] : undefined;
      return provider ? ctx.modelApi.listModels(provider) : ctx.bridge.listModels(cli);
    },
  };
}
