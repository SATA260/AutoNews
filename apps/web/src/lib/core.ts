import 'server-only';
import { CORE_VERSION } from '@aidaily/core';

/** 返回当前加载的核心引擎版本号，供服务端渲染与接口健康检查使用 */
export function getCoreVersion(): string {
  return CORE_VERSION;
}
