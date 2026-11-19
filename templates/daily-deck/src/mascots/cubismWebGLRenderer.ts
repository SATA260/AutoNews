import type { MascotMood } from '../schema/newsSchema';
import {
  computeMascotProjection,
  type ModelRestBounds,
  type MotionClipSummary,
  positiveModulo,
  selectMotionSample,
} from './cubismMotionHelpers';

/** 全局注入的官方 Cubism Core 运行时最小接口声明 */
interface CubismCoreGlobal {
  Version: {
    csmGetVersion: () => number;
  };
  Moc: {
    fromArrayBuffer: (buffer: ArrayBuffer) => CubismMocInstance | null;
    prototype: {
      hasMocConsistency?: (buffer: ArrayBuffer) => number;
    };
  };
  Model: {
    fromMoc: (moc: CubismMocInstance) => CubismModelInstance | null;
  };
}

/** 底层骨骼二进制数据对象实例结构 */
interface CubismMocInstance {
  _release?: () => void;
}

/** 模型画布原始像素尺寸与原点缩放比例信息 */
interface CubismCanvasInfo {
  CanvasWidth: number;
  CanvasHeight: number;
  CanvasOriginX: number;
  CanvasOriginY: number;
  PixelsPerUnit: number;
}

/** 模型可驱动的形变与关节参数数组集合 */
interface CubismParameters {
  count: number;
  ids: string[];
  minimumValues: Float32Array;
  maximumValues: Float32Array;
  defaultValues: Float32Array;
  values: Float32Array;
}

/** 模型所有可绘制图层网格、纹理索引、遮罩列表与混合标志 */
interface CubismDrawables {
  count: number;
  ids: string[];
  constantFlags: Uint8Array;
  dynamicFlags: Uint8Array;
  textureIndices: Int32Array;
  drawOrders: Int32Array;
  renderOrders: Int32Array;
  opacities: Float32Array;
  maskCounts: Int32Array;
  masks: Int32Array[];
  vertexCounts: Int32Array;
  vertexPositions: Float32Array[];
  vertexUvs: Float32Array[];
  indexCounts: Int32Array;
  indices: Uint16Array[];
  resetDynamicFlags: () => void;
}

/** 模型可调节不透明度的部件集合 */
interface CubismParts {
  count: number;
  ids: string[];
  opacities: Float32Array;
}

/** 已实例化的角色运行时模型对象 */
interface CubismModelInstance {
  canvasinfo: CubismCanvasInfo;
  parameters: CubismParameters;
  parts?: CubismParts;
  drawables: CubismDrawables;
  update: () => void;
  release: () => void;
}

/** 模型入口清单 `.model3.json` 的资源文件引用结构 */
interface Model3Json {
  FileReferences?: {
    Moc?: string;
    Textures?: string[];
    Physics?: string;
    Expressions?: Array<{ Name: string; File: string }>;
    Motions?: Record<string, Array<{ File: string; FadeInTime?: number; FadeOutTime?: number }>>;
  };
}

/** 动作文件中单条参数随时间变化的关键帧片段定义 */
interface Motion3Curve {
  Target: string;
  Id: string;
  Segments: number[];
}

/** 动作配置文件 `.motion3.json` 的元信息与曲线集合 */
interface Motion3Json {
  Meta?: {
    Duration?: number;
    Fps?: number;
    Loop?: boolean;
  };
  Curves?: Motion3Curve[];
}

/** 表情配置文件 `.exp3.json` 的参数目标值与叠加方式 */
interface Expression3Json {
  FadeInTime?: number;
  FadeOutTime?: number;
  Parameters?: Array<{
    Id: string;
    Value: number;
    Blend?: 'Add' | 'Multiply' | 'Overwrite' | string;
  }>;
}

/** 物理单摆链中单个质点节点的惯性与阻尼配置 */
interface PhysicsVertexSpec {
  Position: { X: number; Y: number };
  Mobility: number;
  Delay: number;
  Acceleration: number;
  Radius: number;
}

/** 单个物理模拟组（如前发、侧发或衣摆）的输入输出与节点配置 */
interface PhysicsSettingSpec {
  Id: string;
  Input: Array<{
    Source: { Target: string; Id: string };
    Weight: number;
    Type: 'X' | 'Y' | 'Angle' | string;
    Reflect: boolean;
  }>;
  Output: Array<{
    Destination: { Target: string; Id: string };
    VertexIndex: number;
    Scale: number;
    Weight: number;
    Type: 'X' | 'Y' | 'Angle' | string;
    Reflect: boolean;
  }>;
  Vertices: PhysicsVertexSpec[];
  Normalization?: {
    Position?: { Minimum: number; Default: number; Maximum: number };
    Angle?: { Minimum: number; Default: number; Maximum: number };
  };
}

/** 物理配置文件 `.physics3.json` 顶层结构 */
interface Physics3Json {
  Meta?: {
    Fps?: number;
  };
  PhysicsSettings?: PhysicsSettingSpec[];
}

/** 单摆链中单个节点在运行时的坐标与速度状态 */
interface PendulumNodeState {
  restX: number;
  restY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  mobility: number;
  delay: number;
  acceleration: number;
  radius: number;
}

/** 单个物理链条的配置与实时节点数组 */
interface PhysicsRigChain {
  spec: PhysicsSettingSpec;
  nodes: PendulumNodeState[];
}

declare global {
  interface Window {
    Live2DCubismCore?: CubismCoreGlobal;
  }
}

/** 单帧推进 Live2D 看板娘状态与画面渲染所需的输入参数 */
export interface CubismStepParams {
  timeMs: number;
  dtMs: number;
  mouthOpen: number;
  mood: MascotMood;
  speaking: boolean;
}

/** 已加载完成的 Live2D WebGL 渲染控制器接口 */
export interface CubismMascotController {
  /** 按给定全局毫秒时间、帧间隔与口型振幅更新骨骼物理并立即绘制一帧 */
  step: (params: CubismStepParams) => void;
  /** 重置表情权重与发丝单摆初值，并从章节起点往前按固定步长和真实表情确定性预热 */
  warmup: (atTimeMs: number, steps?: number, mood?: MascotMood, stepMs?: number) => void;
  /** 释放 WebGL 纹理、缓冲区与底层模型内存 */
  dispose: () => void;
  /** 查询当前控制器是否已销毁或发生上下文丢失 */
  isDisposed: () => boolean;
}

/** 支持 WebGL2 与 WebGL1 共享绘图接口的渲染上下文联合类型 */
type SupportedWebGLContext = WebGL2RenderingContext | WebGLRenderingContext;

const VERTEX_SHADER_SRC = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform vec2 u_scale;
uniform vec2 u_offset;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_pos * u_scale + u_offset, 0.0, 1.0);
  v_uv = a_uv;
}
`;

const FRAGMENT_SHADER_SRC = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform float u_mask_pass;
void main() {
  vec4 c = texture2D(u_tex, v_uv);
  if (u_mask_pass > 0.5) {
    if (c.a <= 0.05) {
      discard;
    }
    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
    return;
  }
  gl_FragColor = c * u_opacity;
}
`;

const BLEND_ADDITIVE_BIT = 1 << 0;
const BLEND_MULTIPLICATIVE_BIT = 1 << 1;
const INVERTED_MASK_BIT = 1 << 3;
const VISIBLE_DYNAMIC_BIT = 1 << 0;

/** 从动作文件提取时长、循环方式以及是否自带微笑嘴型曲线的摘要信息 */
function summarizeMotionClip(motion: Motion3Json | null): MotionClipSummary | null {
  if (!motion?.Curves?.length) {
    return null;
  }
  return {
    durationSec: motion.Meta?.Duration ?? 7.2,
    loop: motion.Meta?.Loop,
    hasMouthFormCurve: motion.Curves.some(
      (curve) => curve.Target === 'Parameter' && curve.Id === 'ParamMouthForm',
    ),
  };
}

/** 按指定优先级在动作映射表中查找对应动作分组的文件路径（兼容大小写键名） */
function findMotionGroupFile(
  motions: Model3Json['FileReferences'] extends undefined
    ? never
    : NonNullable<Model3Json['FileReferences']>['Motions'],
  targetKey: string,
): string | undefined {
  if (!motions) {
    return undefined;
  }
  const direct = motions[targetKey]?.[0]?.File;
  if (direct) {
    return direct;
  }
  const lower = targetKey.toLowerCase();
  for (const [key, items] of Object.entries(motions)) {
    if (key.toLowerCase() === lower && items?.[0]?.File) {
      return items[0].File;
    }
  }
  return undefined;
}

/** 拼接基于模型描述文件所在目录的子资源相对路径 */
function joinRelativeAssetUrl(baseFileUrl: string, relativeRef: string): string {
  const cleanRel = relativeRef.replace(/^\.\//, '');
  const slashIdx = baseFileUrl.lastIndexOf('/');
  if (slashIdx < 0) {
    return cleanRel;
  }
  return `${baseFileUrl.slice(0, slashIdx + 1)}${cleanRel}`;
}

/** 等待全局 Cubism Core 内核完成初始化 */
async function waitForCubismCore(timeoutMs = 6000): Promise<CubismCoreGlobal> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const core = typeof window !== 'undefined' ? window.Live2DCubismCore : undefined;
    if (core && typeof core.Version?.csmGetVersion === 'function') {
      try {
        if (core.Version.csmGetVersion() > 0) {
          return core;
        }
      } catch {
        // 内核尚未完成初始化时短暂等待重试
      }
    }
    await new Promise<void>((r) => setTimeout(r, 15));
  }
  throw new Error('Live2D 核心运行时未就绪');
}

/** 加载单张贴图图像对象 */
function loadImageElement(assetUrl: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`贴图加载失败: ${assetUrl}`));
    img.src = assetUrl;
  });
}

/** 读取本地静态服务的 JSON 配置文件 */
async function readLocalJson<T>(assetUrl: string): Promise<T> {
  const res = await window.fetch(assetUrl);
  if (!res.ok) {
    throw new Error(`资源读取失败 (${res.status}): ${assetUrl}`);
  }
  return (await res.json()) as T;
}

/** 读取本地静态服务的二进制文件 */
async function readLocalBinary(assetUrl: string): Promise<ArrayBuffer> {
  const res = await window.fetch(assetUrl);
  if (!res.ok) {
    throw new Error(`二进制资源读取失败 (${res.status}): ${assetUrl}`);
  }
  return res.arrayBuffer();
}

/** 编译单个 WebGL 着色器并在失败时抛出清晰错误 */
function compileShader(gl: SupportedWebGLContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('创建 WebGL 着色器失败');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? '未知编译错误';
    gl.deleteShader(shader);
    throw new Error(`编译 WebGL 着色器失败: ${info}`);
  }
  return shader;
}

/** 在指定时间点采样单条动作关键帧曲线数值 */
function evaluateMotionSegments(segments: number[], tSec: number): number {
  if (segments.length < 2) {
    return 0;
  }
  let x0 = segments[0] ?? 0;
  let y0 = segments[1] ?? 0;
  if (tSec <= x0) {
    return y0;
  }

  let cursor = 2;
  while (cursor < segments.length) {
    const segType = segments[cursor];
    if (segType === 0) {
      const x1 = segments[cursor + 1] ?? x0;
      const y1 = segments[cursor + 2] ?? y0;
      if (tSec <= x1) {
        const span = x1 - x0;
        const u = span > 1e-6 ? (tSec - x0) / span : 0;
        return y0 + (y1 - y0) * u;
      }
      x0 = x1;
      y0 = y1;
      cursor += 3;
    } else if (segType === 1) {
      const cy1 = segments[cursor + 2] ?? y0;
      const cy2 = segments[cursor + 4] ?? y0;
      const x3 = segments[cursor + 5] ?? x0;
      const y3 = segments[cursor + 6] ?? y0;
      if (tSec <= x3) {
        const span = x3 - x0;
        const u = span > 1e-6 ? Math.min(1, Math.max(0, (tSec - x0) / span)) : 0;
        const inv = 1 - u;
        return (
          inv * inv * inv * y0 + 3 * inv * inv * u * cy1 + 3 * inv * u * u * cy2 + u * u * u * y3
        );
      }
      x0 = x3;
      y0 = y3;
      cursor += 7;
    } else if (segType === 2) {
      const x1 = segments[cursor + 1] ?? x0;
      const y1 = segments[cursor + 2] ?? y0;
      if (tSec < x1) {
        return y0;
      }
      x0 = x1;
      y0 = y1;
      cursor += 3;
    } else if (segType === 3) {
      const x1 = segments[cursor + 1] ?? x0;
      const y1 = segments[cursor + 2] ?? y0;
      if (tSec <= x1) {
        return y1;
      }
      x0 = x1;
      y0 = y1;
      cursor += 3;
    } else {
      break;
    }
  }
  return y0;
}

/** 计算确定性自然眨眼开合度（支持预热负时间，周期 4.3 秒，避开 800ms 封面抓图时刻） */
function computeDeterministicEyeOpen(timeMs: number): number {
  if (timeMs >= 550 && timeMs <= 1250) {
    return 1;
  }
  const cycleMs = 4300;
  const phaseMs = positiveModulo(timeMs + 1600, cycleMs);
  const blinkWindowMs = 170;
  if (phaseMs > blinkWindowMs) {
    return 1;
  }
  const half = blinkWindowMs / 2;
  const dist = Math.abs(phaseMs - half) / half;
  return Math.min(1, Math.max(0, dist * dist));
}

/** 根据物理配置初始化单摆顶点状态链 */
function createPhysicsChains(physicsJson: Physics3Json | null): PhysicsRigChain[] {
  if (!physicsJson?.PhysicsSettings) {
    return [];
  }
  return physicsJson.PhysicsSettings.map((spec) => ({
    spec,
    nodes: spec.Vertices.map((v, idx) => {
      const restX = v.Position?.X ?? 0;
      const restY = idx === 0 ? 0 : -(v.Radius || 12) * idx;
      return {
        restX,
        restY,
        x: restX,
        y: restY,
        vx: 0,
        vy: 0,
        mobility: v.Mobility ?? 0.95,
        delay: v.Delay ?? 0.85,
        acceleration: v.Acceleration ?? 1.0,
        radius: Math.max(1, v.Radius || 12),
      };
    }),
  }));
}

/** 加载指定 `.model3.json` 并创建支持逐帧确定性步进、模板缓冲遮罩与上下文丢失检测的透明 WebGL 控制器 */
export async function loadCubismMascotController(
  canvas: HTMLCanvasElement,
  modelJsonUrl: string,
  onContextLost?: (reason: string) => void,
): Promise<CubismMascotController> {
  const core = await waitForCubismCore();
  const manifest = await readLocalJson<Model3Json>(modelJsonUrl);
  const refs = manifest.FileReferences;
  if (!refs?.Moc || !refs.Textures?.length) {
    throw new Error(`模型描述文件缺少骨骼或贴图引用: ${modelJsonUrl}`);
  }

  const resolveRel = (rel: string) => joinRelativeAssetUrl(modelJsonUrl, rel);
  const idleFile = findMotionGroupFile(refs.Motions, 'Idle');
  const talkFile = findMotionGroupFile(refs.Motions, 'Talk');
  const fullBodyFile = findMotionGroupFile(refs.Motions, 'FullBody');

  const [mocBuffer, images, physicsJson, idleMotion, talkMotion, fullBodyMotion, expressionsMap] =
    await Promise.all([
      readLocalBinary(resolveRel(refs.Moc)),
      Promise.all(refs.Textures.map((texRel) => loadImageElement(resolveRel(texRel)))),
      refs.Physics
        ? readLocalJson<Physics3Json>(resolveRel(refs.Physics)).catch(() => null)
        : Promise.resolve(null),
      idleFile
        ? readLocalJson<Motion3Json>(resolveRel(idleFile)).catch(() => null)
        : Promise.resolve(null),
      talkFile
        ? readLocalJson<Motion3Json>(resolveRel(talkFile)).catch(() => null)
        : Promise.resolve(null),
      fullBodyFile
        ? readLocalJson<Motion3Json>(resolveRel(fullBodyFile)).catch(() => null)
        : Promise.resolve(null),
      (async () => {
        const map = new Map<string, Expression3Json>();
        for (const item of refs.Expressions ?? []) {
          try {
            const expData = await readLocalJson<Expression3Json>(resolveRel(item.File));
            map.set(item.Name.toLowerCase(), expData);
          } catch {
            // 可选表情文件缺失时静默忽略
          }
        }
        return map;
      })(),
    ]);

  if (
    typeof core.Moc.prototype.hasMocConsistency === 'function' &&
    core.Moc.prototype.hasMocConsistency(mocBuffer) !== 1
  ) {
    throw new Error('Live2D 骨骼二进制数据一致性校验未通过');
  }

  const glAttrs: WebGLContextAttributes = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
    stencil: true,
    depth: false,
  };
  const gl: SupportedWebGLContext | null =
    canvas.getContext('webgl2', glAttrs) ?? canvas.getContext('webgl', glAttrs);
  if (!gl) {
    throw new Error('当前运行环境不支持 WebGL 渲染上下文');
  }

  const moc = core.Moc.fromArrayBuffer(mocBuffer);
  if (!moc) {
    throw new Error('解析 Live2D Moc 数据失败');
  }
  const model = core.Model.fromMoc(moc);
  if (!model) {
    moc._release?.();
    throw new Error('实例化 Live2D 模型失败');
  }

  let hasAnyMaskedDrawable = false;
  for (let i = 0; i < model.drawables.count; i++) {
    if ((model.drawables.maskCounts[i] ?? 0) > 0) {
      hasAnyMaskedDrawable = true;
      break;
    }
  }
  if (hasAnyMaskedDrawable && Number(gl.getParameter(gl.STENCIL_BITS)) < 1) {
    model.release();
    moc._release?.();
    throw new Error('模型包含遮罩裁剪图层但当前 WebGL 上下文不支持模板缓冲区');
  }

  let disposed = false;
  let contextLost = false;
  const textures: WebGLTexture[] = [];
  let program: WebGLProgram | null = null;
  let posBuffer: WebGLBuffer | null = null;
  let uvBuffer: WebGLBuffer | null = null;
  let idxBuffer: WebGLBuffer | null = null;

  const handleWebGLContextLost = (event: Event) => {
    event.preventDefault();
    if (contextLost) {
      return;
    }
    contextLost = true;
    disposed = true;
    onContextLost?.('Live2D WebGL 渲染上下文丢失');
  };
  canvas.addEventListener('webglcontextlost', handleWebGLContextLost);

  try {
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
    program = gl.createProgram();
    if (!program) {
      throw new Error('创建 WebGL Program 失败');
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`链接 WebGL Program 失败: ${gl.getProgramInfoLog(program) ?? ''}`);
    }

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);

    for (const img of images) {
      const tex = gl.createTexture();
      if (!tex) {
        throw new Error('创建 WebGL 贴图对象失败');
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const isPot = (img.width & (img.width - 1)) === 0 && (img.height & (img.height - 1)) === 0;
      if (isPot) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      textures.push(tex);
    }

    posBuffer = gl.createBuffer();
    uvBuffer = gl.createBuffer();
    idxBuffer = gl.createBuffer();
    if (!posBuffer || !uvBuffer || !idxBuffer) {
      throw new Error('分配 WebGL 几何顶点缓冲区失败');
    }

    const aPosLoc = gl.getAttribLocation(program, 'a_pos');
    const aUvLoc = gl.getAttribLocation(program, 'a_uv');
    const uScaleLoc = gl.getUniformLocation(program, 'u_scale');
    const uOffsetLoc = gl.getUniformLocation(program, 'u_offset');
    const uTexLoc = gl.getUniformLocation(program, 'u_tex');
    const uOpacityLoc = gl.getUniformLocation(program, 'u_opacity');
    const uMaskPassLoc = gl.getUniformLocation(program, 'u_mask_pass');

    const paramIndexById = new Map<string, number>();
    for (let i = 0; i < model.parameters.count; i++) {
      const id = model.parameters.ids[i];
      if (id) {
        paramIndexById.set(id, i);
      }
    }

    const partIndexById = new Map<string, number>();
    let defaultPartOpacities: Float32Array | null = null;
    if (model.parts) {
      for (let i = 0; i < model.parts.count; i++) {
        const id = model.parts.ids[i];
        if (id) {
          partIndexById.set(id, i);
        }
      }
      defaultPartOpacities = new Float32Array(model.parts.opacities);
    }

    const setParam = (id: string, val: number) => {
      const idx = paramIndexById.get(id);
      if (idx === undefined) {
        return;
      }
      const minV = model.parameters.minimumValues[idx] ?? -30;
      const maxV = model.parameters.maximumValues[idx] ?? 30;
      model.parameters.values[idx] = Math.min(maxV, Math.max(minV, val));
    };

    const getParam = (id: string): number => {
      const idx = paramIndexById.get(id);
      return idx !== undefined ? (model.parameters.values[idx] ?? 0) : 0;
    };

    const fullBodySummary = summarizeMotionClip(fullBodyMotion);
    const idleSummary = summarizeMotionClip(idleMotion);
    const talkSummary = summarizeMotionClip(talkMotion);

    /** 在默认静止姿态下采样可见顶点坐标范围，消除模型画布额外边距带来的尺寸偏移 */
    const computeModelRestBounds = (): ModelRestBounds | null => {
      for (let i = 0; i < model.parameters.count; i++) {
        model.parameters.values[i] = model.parameters.defaultValues[i] ?? 0;
      }
      if (model.parts && defaultPartOpacities) {
        model.parts.opacities.set(defaultPartOpacities);
      }
      model.update();
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (let dIdx = 0; dIdx < model.drawables.count; dIdx++) {
        const dynFlag = model.drawables.dynamicFlags[dIdx] ?? 0;
        if (
          (dynFlag & VISIBLE_DYNAMIC_BIT) === 0 ||
          (model.drawables.opacities[dIdx] ?? 1) <= 0.001
        ) {
          continue;
        }
        const positions = model.drawables.vertexPositions[dIdx];
        if (!positions) {
          continue;
        }
        for (let k = 0; k + 1 < positions.length; k += 2) {
          const vx = positions[k] ?? 0;
          const vy = positions[k + 1] ?? 0;
          if (vx < minX) minX = vx;
          if (vx > maxX) maxX = vx;
          if (vy < minY) minY = vy;
          if (vy > maxY) maxY = vy;
        }
      }
      model.drawables.resetDynamicFlags();
      if (
        !Number.isFinite(minX) ||
        !Number.isFinite(maxX) ||
        !Number.isFinite(minY) ||
        !Number.isFinite(maxY)
      ) {
        return null;
      }
      return { minX, maxX, minY, maxY };
    };
    const restBounds = computeModelRestBounds();

    const physicsChains = createPhysicsChains(physicsJson);
    const expressionWeights = new Map<string, number>();

    /** 将表情融合权重与发丝单摆链重置为指定情绪下的确定性初始静止状态 */
    const resetDynamicState = (initialMood: MascotMood) => {
      const targetKey = initialMood.toLowerCase();
      for (const key of expressionsMap.keys()) {
        expressionWeights.set(key, key === targetKey ? 1 : 0);
      }
      for (const chain of physicsChains) {
        for (const node of chain.nodes) {
          node.x = node.restX;
          node.y = node.restY;
          node.vx = 0;
          node.vy = 0;
        }
      }
    };

    resetDynamicState('neutral');

    const ppu = Math.max(1, model.canvasinfo.PixelsPerUnit || 1000);
    const unitW = Math.max(0.2, (model.canvasinfo.CanvasWidth || 1000) / ppu);
    const unitH = Math.max(0.2, (model.canvasinfo.CanvasHeight || 1000) / ppu);

    /** 绘制单个指定编号的网格图层（可供遮罩通道和主绘制通道复用） */
    const drawSingleMesh = (dIdx: number, isMaskPass: boolean, opacity: number) => {
      if (!posBuffer || !uvBuffer || !idxBuffer) {
        return;
      }
      const indexCount = model.drawables.indexCounts[dIdx] ?? 0;
      if (indexCount <= 0) {
        return;
      }
      const texIdx = model.drawables.textureIndices[dIdx] ?? 0;
      const tex = textures[texIdx] ?? textures[0];
      if (!tex) {
        return;
      }
      const positions = model.drawables.vertexPositions[dIdx];
      const uvs = model.drawables.vertexUvs[dIdx];
      const indices = model.drawables.indices[dIdx];
      if (!positions || !uvs || !indices) {
        return;
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1f(uOpacityLoc, opacity);
      gl.uniform1f(uMaskPassLoc, isMaskPass ? 1.0 : 0.0);

      gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aPosLoc);
      gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(aUvLoc);
      gl.vertexAttribPointer(aUvLoc, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

      gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
    };

    const applyParametersAndPhysics = (params: CubismStepParams, renderFrame: boolean) => {
      if (contextLost || gl.isContextLost()) {
        contextLost = true;
        disposed = true;
        onContextLost?.('Live2D WebGL 渲染上下文丢失');
        throw new Error('Live2D WebGL 渲染上下文丢失');
      }
      if (disposed) {
        return;
      }
      const timeSec = params.timeMs / 1000;
      const dtSec = Math.min(0.1, Math.max(1 / 240, params.dtMs / 1000));

      for (let i = 0; i < model.parameters.count; i++) {
        model.parameters.values[i] = model.parameters.defaultValues[i] ?? 0;
      }
      if (model.parts && defaultPartOpacities) {
        model.parts.opacities.set(defaultPartOpacities);
      }

      const selectedSample = selectMotionSample({
        timeSec,
        speaking: params.speaking,
        fullBody: fullBodySummary,
        idle: idleSummary,
        talk: talkSummary,
      });
      const activeMotion =
        selectedSample?.clipKind === 'fullbody'
          ? fullBodyMotion
          : selectedSample?.clipKind === 'talk'
            ? talkMotion
            : selectedSample?.clipKind === 'idle'
              ? idleMotion
              : null;

      if (selectedSample && activeMotion?.Curves?.length) {
        const localT = selectedSample.localTimeSec;
        for (const curve of activeMotion.Curves) {
          if (curve.Target === 'Parameter') {
            if (curve.Id === 'ParamMouthOpenY') {
              continue;
            }
            setParam(curve.Id, evaluateMotionSegments(curve.Segments, localT));
          } else if (curve.Target === 'PartOpacity' && model.parts) {
            const pIdx = partIndexById.get(curve.Id);
            if (pIdx !== undefined) {
              const rawOpacity = evaluateMotionSegments(curve.Segments, localT);
              model.parts.opacities[pIdx] = Math.min(1, Math.max(0, rawOpacity));
            }
          }
        }
      } else {
        setParam('ParamBreath', 0.5 + 0.5 * Math.sin((2 * Math.PI * timeSec) / 3.2));
        setParam('ParamAngleX', 3.5 * Math.sin((2 * Math.PI * timeSec) / 6.4));
        setParam('ParamAngleY', 2.2 * Math.cos((2 * Math.PI * timeSec) / 5.2));
        setParam('ParamAngleZ', 2.6 * Math.sin((2 * Math.PI * timeSec) / 7.2));
      }

      const eyeOpen = computeDeterministicEyeOpen(params.timeMs);
      setParam('ParamEyeLOpen', eyeOpen);
      setParam('ParamEyeROpen', eyeOpen);

      const clampedMouth = Math.min(1, Math.max(0, params.mouthOpen));
      setParam('ParamMouthOpenY', clampedMouth);
      setParam('PARAM_MOUTH_OPEN_Y', clampedMouth);
      if (clampedMouth > 0.04) {
        setParam('ParamAngleY', getParam('ParamAngleY') - clampedMouth * 2.1);
        setParam(
          'ParamAngleZ',
          getParam('ParamAngleZ') + Math.sin(timeSec * 3.6) * clampedMouth * 1.2,
        );
      }

      const targetMood = params.mood.toLowerCase();
      for (const [expName, expSpec] of expressionsMap.entries()) {
        const prevW = expressionWeights.get(expName) ?? 0;
        const targetW = expName === targetMood ? 1 : 0;
        const fadeSec = Math.max(
          0.05,
          targetW > prevW ? (expSpec.FadeInTime ?? 0.22) : (expSpec.FadeOutTime ?? 0.25),
        );
        const stepDelta = dtSec / fadeSec;
        const nextW =
          Math.abs(targetW - prevW) <= stepDelta
            ? targetW
            : prevW + Math.sign(targetW - prevW) * stepDelta;
        expressionWeights.set(expName, nextW);

        if (nextW > 0.001 && expSpec.Parameters) {
          for (const p of expSpec.Parameters) {
            // 中性情绪播放全身动作期间保留动作自带的温和嘴角微笑曲线
            if (
              targetMood === 'neutral' &&
              expName === 'neutral' &&
              selectedSample?.preserveNeutralMouthForm &&
              p.Id === 'ParamMouthForm'
            ) {
              continue;
            }
            const baseVal = getParam(p.Id);
            if (p.Blend === 'Add') {
              setParam(p.Id, baseVal + p.Value * nextW);
            } else if (p.Blend === 'Multiply') {
              setParam(p.Id, baseVal * (1 + (p.Value - 1) * nextW));
            } else {
              setParam(p.Id, baseVal * (1 - nextW) + p.Value * nextW);
            }
          }
        }
      }

      for (const chain of physicsChains) {
        let driveAngleRad = 0;
        let driveShiftX = 0;
        let driveShiftY = 0;
        const normAngle = Math.max(1, Math.abs(chain.spec.Normalization?.Angle?.Maximum ?? 10));
        const normPos = Math.max(1, Math.abs(chain.spec.Normalization?.Position?.Maximum ?? 10));

        for (const inp of chain.spec.Input) {
          const idx = paramIndexById.get(inp.Source.Id);
          if (idx === undefined) {
            continue;
          }
          const pVal = model.parameters.values[idx] ?? 0;
          const pMax = Math.max(
            1e-4,
            Math.abs(model.parameters.maximumValues[idx] ?? 30),
            Math.abs(model.parameters.minimumValues[idx] ?? -30),
          );
          const sign = inp.Reflect ? -1 : 1;
          const weightRatio = (inp.Weight ?? 50) / 100;
          const normalized = (pVal / pMax) * sign * weightRatio;
          if (inp.Type === 'Angle') {
            driveAngleRad += (normalized * normAngle * Math.PI) / 180;
          } else if (inp.Type === 'Y') {
            driveShiftY += normalized * normPos;
          } else {
            driveShiftX += normalized * normPos;
          }
        }

        const subSteps = 2;
        const h = dtSec / subSteps;
        for (let s = 0; s < subSteps; s++) {
          const root = chain.nodes[0];
          if (root) {
            root.x = driveShiftX;
            root.y = driveShiftY;
          }
          for (let ni = 1; ni < chain.nodes.length; ni++) {
            const prev = chain.nodes[ni - 1];
            const curr = chain.nodes[ni];
            if (!prev || !curr) {
              continue;
            }
            const restAngle = -Math.PI / 2 + driveAngleRad * curr.mobility;
            const targetX = prev.x + Math.cos(restAngle) * curr.radius;
            const targetY = prev.y + Math.sin(restAngle) * curr.radius;
            const stiffness = 26 * curr.acceleration;
            const damping = 5.8 + (1 - curr.delay) * 4.0;
            const ax = (targetX - curr.x) * stiffness - curr.vx * damping;
            const ay = (targetY - curr.y) * stiffness - curr.vy * damping;
            curr.vx += ax * h;
            curr.vy += ay * h;
            curr.x += curr.vx * h;
            curr.y += curr.vy * h;

            const dx = curr.x - prev.x;
            const dy = curr.y - prev.y;
            const dist = Math.hypot(dx, dy) || 1e-5;
            curr.x = prev.x + (dx / dist) * curr.radius;
            curr.y = prev.y + (dy / dist) * curr.radius;
          }
        }

        for (const out of chain.spec.Output) {
          const vIdx = Math.min(chain.nodes.length - 1, Math.max(1, out.VertexIndex));
          const prev = chain.nodes[vIdx - 1];
          const curr = chain.nodes[vIdx];
          if (!prev || !curr) {
            continue;
          }
          const dx = curr.x - prev.x;
          const dy = curr.y - prev.y;
          const swingRad = Math.atan2(dx, Math.max(1e-4, -dy));
          const sign = out.Reflect ? -1 : 1;
          const outVal = swingRad * (out.Scale ?? 1) * sign * 2.8;
          const blendW = Math.min(1, Math.max(0, (out.Weight ?? 100) / 100));
          const existing = getParam(out.Destination.Id);
          setParam(out.Destination.Id, existing * (1 - blendW) + outVal * blendW);
        }
      }

      model.update();

      if (!renderFrame || !program || !posBuffer || !uvBuffer || !idxBuffer) {
        model.drawables.resetDynamicFlags();
        return;
      }

      const cw = Math.max(1, canvas.width);
      const ch = Math.max(1, canvas.height);
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 0);
      gl.clearStencil(0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL 原生着色器绑定方法，并非 React Hook
      gl.useProgram(program);
      gl.enable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.STENCIL_TEST);

      const projection = computeMascotProjection({
        canvasWidth: cw,
        canvasHeight: ch,
        unitW,
        unitH,
        restBounds,
      });

      gl.uniform2f(uScaleLoc, projection.scaleX, projection.scaleY);
      gl.uniform2f(uOffsetLoc, projection.offsetX, projection.offsetY);
      gl.uniform1i(uTexLoc, 0);

      const drawCount = model.drawables.count;
      const orderIndices: number[] = [];
      for (let i = 0; i < drawCount; i++) {
        orderIndices.push(i);
      }
      orderIndices.sort(
        (a, b) => (model.drawables.renderOrders[a] ?? 0) - (model.drawables.renderOrders[b] ?? 0),
      );

      for (const dIdx of orderIndices) {
        const dynFlag = model.drawables.dynamicFlags[dIdx] ?? 0;
        if ((dynFlag & VISIBLE_DYNAMIC_BIT) === 0) {
          continue;
        }
        const opacity = model.drawables.opacities[dIdx] ?? 1;
        if (opacity <= 0.001) {
          continue;
        }

        const cFlag = model.drawables.constantFlags[dIdx] ?? 0;
        const maskCount = model.drawables.maskCounts[dIdx] ?? 0;
        const maskList = maskCount > 0 ? model.drawables.masks[dIdx] : undefined;

        if (maskCount > 0 && maskList) {
          gl.enable(gl.STENCIL_TEST);
          gl.clearStencil(0);
          gl.clear(gl.STENCIL_BUFFER_BIT);
          gl.colorMask(false, false, false, false);
          gl.stencilFunc(gl.ALWAYS, 1, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
          for (let m = 0; m < maskCount; m++) {
            const maskIdx = maskList[m];
            if (maskIdx !== undefined && maskIdx >= 0 && maskIdx < drawCount) {
              drawSingleMesh(maskIdx, true, 1.0);
            }
          }
          gl.colorMask(true, true, true, true);
          const isInverted = (cFlag & INVERTED_MASK_BIT) !== 0;
          gl.stencilFunc(isInverted ? gl.NOTEQUAL : gl.EQUAL, 1, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        }

        if ((cFlag & BLEND_ADDITIVE_BIT) !== 0) {
          gl.blendFunc(gl.ONE, gl.ONE);
        } else if ((cFlag & BLEND_MULTIPLICATIVE_BIT) !== 0) {
          gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
        } else {
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        }

        drawSingleMesh(dIdx, false, opacity);

        if (maskCount > 0 && maskList) {
          gl.disable(gl.STENCIL_TEST);
        }
      }

      gl.flush();
      model.drawables.resetDynamicFlags();
    };

    const runDeterministicWarmup = (
      atTimeMs: number,
      steps = 18,
      mood: MascotMood = 'neutral',
      stepMs = 1000 / 30,
    ) => {
      const safeSteps = Math.max(1, Math.min(90, Math.floor(steps)));
      const safeStepMs = stepMs > 0 && Number.isFinite(stepMs) ? stepMs : 1000 / 30;
      resetDynamicState(mood);
      const startMs = atTimeMs - safeSteps * safeStepMs;
      for (let i = 0; i < safeSteps; i++) {
        applyParametersAndPhysics(
          {
            timeMs: startMs + i * safeStepMs,
            dtMs: safeStepMs,
            mouthOpen: 0,
            mood,
            speaking: false,
          },
          i === safeSteps - 1,
        );
      }
    };

    runDeterministicWarmup(0, 18, 'neutral', 1000 / 30);

    return {
      step(params: CubismStepParams) {
        applyParametersAndPhysics(params, true);
      },
      warmup(atTimeMs: number, steps = 18, mood: MascotMood = 'neutral', stepMs = 1000 / 30) {
        runDeterministicWarmup(atTimeMs, steps, mood, stepMs);
      },
      dispose() {
        if (disposed && !contextLost) {
          return;
        }
        disposed = true;
        canvas.removeEventListener('webglcontextlost', handleWebGLContextLost);
        if (!contextLost && !gl.isContextLost()) {
          for (const t of textures) {
            gl.deleteTexture(t);
          }
          if (posBuffer) gl.deleteBuffer(posBuffer);
          if (uvBuffer) gl.deleteBuffer(uvBuffer);
          if (idxBuffer) gl.deleteBuffer(idxBuffer);
          if (program) gl.deleteProgram(program);
        }
        model.release();
        moc._release?.();
      },
      isDisposed() {
        return disposed || contextLost || gl.isContextLost();
      },
    };
  } catch (err) {
    disposed = true;
    canvas.removeEventListener('webglcontextlost', handleWebGLContextLost);
    if (!contextLost && !gl.isContextLost()) {
      for (const t of textures) {
        gl.deleteTexture(t);
      }
      if (posBuffer) gl.deleteBuffer(posBuffer);
      if (uvBuffer) gl.deleteBuffer(uvBuffer);
      if (idxBuffer) gl.deleteBuffer(idxBuffer);
      if (program) gl.deleteProgram(program);
    }
    model.release();
    moc._release?.();
    throw err;
  }
}
