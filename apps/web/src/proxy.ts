import { type NextRequest, NextResponse } from 'next/server';
import { verifyLocalWebRequest } from '@/lib/request-security';

/** 统一校验管理台与接口请求的主机头、跨站来源及可选访问令牌 */
export function proxy(request: NextRequest) {
  const verdict = verifyLocalWebRequest(request);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }
  return NextResponse.next();
}

/** 排除静态资源请求，覆盖所有页面、服务端操作与接口路由 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
