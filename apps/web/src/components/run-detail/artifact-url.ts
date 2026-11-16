/** 生成指向指定期次运行目录内产物文件的安全访问地址 */
export function buildArtifactUrl(runId: string, relPath: string): string {
  const encodedSegments = relPath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  return `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodedSegments.join('/')}`;
}
