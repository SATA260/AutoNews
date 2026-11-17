import path from 'node:path';
import type { ContentLimits, Settings, TemplateAdapter } from '@aidaily/contracts';
import type { CoreContext } from '../context.js';
import { createDailyDeckAdapter } from './adapters/daily-deck.js';
import { createSolidColorAdapter } from './adapters/solid-color.js';

/** 已解析的模板适配器及其所在磁盘目录 */
export interface ResolvedTemplate {
  name: string;
  dir: string;
  adapter: TemplateAdapter;
}

/**
 * 模板适配器注册中心：集中维护内置或外部扩展的视频模板适配器，支持按名称查询和动态注册。
 */
export class TemplateRegistry {
  private readonly adapters = new Map<string, TemplateAdapter>();

  constructor(initial?: TemplateAdapter[]) {
    for (const adapter of initial ?? []) {
      this.register(adapter);
    }
  }

  /** 注册或替换指定名称的模板适配器 */
  register(adapter: TemplateAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /** 根据适配器名称查找已注册实例，不存在时返回 undefined */
  get(adapterId: string): TemplateAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  /** 列出当前已注册的全部适配器名称 */
  list(): string[] {
    return Array.from(this.adapters.keys());
  }
}

/** 创建包含系统内置默认适配器（新闻画报、纯色排版）的模板注册中心 */
export function createDefaultTemplateRegistry(): TemplateRegistry {
  return new TemplateRegistry([createDailyDeckAdapter(), createSolidColorAdapter()]);
}

/**
 * 根据全局配置中的启用模板名称解析对应的适配器与本地模板路径。
 */
export function resolveActiveTemplate(
  ctx: CoreContext,
  settings: Settings,
  registry: TemplateRegistry = createDefaultTemplateRegistry(),
): ResolvedTemplate {
  const activeName = settings.template.active;
  const entry = settings.template.registry[activeName];
  const adapterId = entry?.adapter ?? activeName;
  const adapter = registry.get(adapterId);
  if (!adapter) {
    throw new Error(
      `未找到启用模板 "${activeName}" 对应的适配器 "${adapterId}"，可用适配器: ${registry.list().join(', ') || '无'}`,
    );
  }
  const relDir = entry?.dir ?? '';
  const dir = relDir ? path.resolve(ctx.paths.rootDir, relDir) : '';
  return { name: activeName, dir, adapter };
}

/** 检查当前模板支持的新闻数量上限。 */
export function validateTemplateItemCount(settings: Settings, itemCount: number): void {
  const active = settings.template.active;
  const adapter = settings.template.registry[active]?.adapter ?? active;
  if (adapter === 'daily-deck' && itemCount > 12)
    throw new RangeError('当前视频模板最多支持 12 条新闻');
}

/**
 * 按当前启用模板声明的视觉限制与调用方显式覆写值，汇总生效的文案字数约束。
 */
export function resolveEffectiveContentLimits(
  ctx: CoreContext,
  settings: Settings,
  override?: Partial<ContentLimits>,
): Partial<ContentLimits> {
  try {
    const resolved = resolveActiveTemplate(ctx, settings);
    return {
      ...resolved.adapter.contentLimits,
      ...override,
    };
  } catch {
    return { ...override };
  }
}
