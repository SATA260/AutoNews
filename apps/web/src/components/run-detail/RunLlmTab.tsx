import type { LlmCallRecord } from '@aidaily/contracts';
import Link from 'next/link';
import { formatTimestamp } from '@/lib/format';

/** 模型调用明细页签组件的参数定义 */
export interface RunLlmTabProps {
  runId: string;
  calls: LlmCallRecord[];
  selectedCallId: number | null;
  selectedCallLog: unknown | null;
  timezone: string;
}

const CALL_STATUS_LABEL: Record<LlmCallRecord['status'], string> = {
  ok: '成功',
  timeout: '超时',
  bad_output: '格式校验失败',
  exit_error: '进程报错退出',
  auth_error: '认证鉴权失效',
};

/** 模型调用明细页签：汇总本期任务所有命令行模型调用的耗时、Token 用量及单次完整提示词与返回日志 */
export function RunLlmTab({
  runId,
  calls,
  selectedCallId,
  selectedCallLog,
  timezone,
}: RunLlmTabProps) {
  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 bg-white shadow-xs">
        <div className="border-b border-slate-100 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-slate-900">
            大模型调用记录（共 {calls.length} 次）
          </h3>
        </div>
        {calls.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">本期任务暂无模型调用记录。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-medium">记录编号</th>
                  <th className="px-3 py-2 font-medium">阶段</th>
                  <th className="px-3 py-2 font-medium">条目</th>
                  <th className="px-3 py-2 font-medium">CLI / 模型</th>
                  <th className="px-3 py-2 font-medium">轮次</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">耗时</th>
                  <th className="px-3 py-2 font-medium">输入 / 输出 Token</th>
                  <th className="px-3 py-2 font-medium">时间</th>
                  <th className="px-3 py-2 font-medium">日志</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {calls.map((call) => {
                  const selected = selectedCallId === call.id;
                  return (
                    <tr key={call.id} className={selected ? 'bg-sky-50' : 'hover:bg-slate-50'}>
                      <td className="px-3 py-2 font-mono text-slate-900">#{call.id}</td>
                      <td className="px-3 py-2 font-mono text-slate-700">{call.stage ?? '-'}</td>
                      <td className="px-3 py-2 font-mono text-slate-500">{call.itemId ?? '-'}</td>
                      <td className="px-3 py-2 font-mono text-slate-700">
                        {call.cli}
                        {call.model ? ` / ${call.model}` : ''}
                      </td>
                      <td className="px-3 py-2 text-slate-700">第 {call.attempt} 次</td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            call.status === 'ok'
                              ? 'font-medium text-emerald-700'
                              : 'font-medium text-rose-700'
                          }
                        >
                          {CALL_STATUS_LABEL[call.status]}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-600">
                        {call.durationMs !== null ? `${call.durationMs}ms` : '-'}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-600">
                        {call.inputTokens ?? '-'} / {call.outputTokens ?? '-'}
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {formatTimestamp(call.createdAt, timezone)}
                      </td>
                      <td className="px-3 py-2">
                        {call.logPath ? (
                          <Link
                            href={`/runs/${encodeURIComponent(runId)}?tab=llm&callId=${call.id}`}
                            className="font-medium text-sky-700 hover:underline"
                          >
                            {selected ? '正在查看' : '查看提示词与响应'}
                          </Link>
                        ) : (
                          <span className="text-slate-400">无日志</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedCallId !== null ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h4 className="text-sm font-semibold text-slate-900">
              调用 #{selectedCallId} 完整请求与输出快照
            </h4>
            <Link
              href={`/runs/${encodeURIComponent(runId)}?tab=llm`}
              className="text-xs text-slate-500 hover:text-slate-800"
            >
              关闭查看
            </Link>
          </div>
          {selectedCallLog === null ? (
            <p className="mt-3 text-xs text-slate-500">未能加载该条调用的详细日志文件。</p>
          ) : (
            <pre className="mt-3 max-h-[36rem] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-900 p-4 font-mono text-[11px] leading-relaxed text-slate-100">
              {JSON.stringify(selectedCallLog, null, 2)}
            </pre>
          )}
        </section>
      ) : null}
    </div>
  );
}
