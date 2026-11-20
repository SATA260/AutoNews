'use client';

import type { ModelApiProvider } from '@aidaily/contracts';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState, useTransition } from 'react';
import {
  type ActionResult,
  removeModelApiConnectionAction,
  saveModelApiConnectionAction,
} from '@/app/actions';

/** 网页上用于编辑连接的信息，密钥只显示是否已配置 */
interface Connection {
  name: string;
  baseUrl: string;
  protocol: ModelApiProvider['protocol'];
  jsonMode?: ModelApiProvider['jsonMode'];
  hasCredential: boolean;
  inUse: boolean;
}

const control =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900';
const primary =
  'rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50';
const secondary =
  'rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50';
const protocols = {
  'chat-completions': 'Chat Completions',
  responses: 'Responses',
};

/** 管理出现在阶段调用方式列表中的第三方模型 API 连接 */
export function ModelApiConnections({ connections }: { connections: Connection[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const selected = connections.find(({ name }) => name === editing);

  /** 打开新增或编辑表单，并收起删除确认 */
  function openEditor(name: string) {
    setEditing(name);
    setRemoving(null);
    setFeedback(null);
  }

  /** 提交连接表单，保存成功后刷新选项并收起表单 */
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setFeedback(null);
    startTransition(async () => {
      const result = await saveModelApiConnectionAction(form);
      setFeedback(result);
      if (result.ok) {
        setEditing(null);
        router.refresh();
      }
    });
  }

  /** 移除已确认删除的连接，并刷新阶段的调用选项 */
  function remove(name: string) {
    const form = new FormData();
    form.set('name', name);
    startTransition(async () => {
      const result = await removeModelApiConnectionAction(form);
      setFeedback(result);
      setRemoving(null);
      if (result.ok) router.refresh();
    });
  }

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3.5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">模型 API 配置</h2>
          <p className="mt-0.5 text-xs text-slate-600">保存后，可按名称为各阶段选择 API 连接。</p>
        </div>
        <button className={primary} type="button" disabled={pending} onClick={() => openEditor('')}>
          添加 API 连接
        </button>
      </div>

      {connections.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {connections.map((connection) => (
            <li
              key={connection.name}
              className="flex flex-wrap items-center justify-between gap-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium text-slate-900">{connection.name}</p>
                <p className="break-all text-xs text-slate-600">{connection.baseUrl}</p>
                <p className="text-xs text-slate-500">
                  {protocols[connection.protocol]} ·{' '}
                  {connection.hasCredential ? '已配置密钥' : '无密钥'}
                  {connection.inUse ? ' · 阶段已选用' : ''}
                </p>
              </div>
              {removing === connection.name ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    className={secondary}
                    onClick={() => setRemoving(null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    className={secondary}
                    onClick={() => remove(connection.name)}
                  >
                    确认删除
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    className={secondary}
                    onClick={() => openEditor(connection.name)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    disabled={pending || connection.inUse}
                    className={secondary}
                    onClick={() => {
                      setRemoving(connection.name);
                      setFeedback(null);
                    }}
                  >
                    删除
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing !== null && (
        <ConnectionForm
          key={editing}
          connection={selected}
          pending={pending}
          onSave={save}
          onCancel={() => {
            setEditing(null);
            setFeedback(null);
          }}
        />
      )}

      {feedback && (
        <p
          role="status"
          className={`rounded-lg px-3 py-2 text-xs ${feedback.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}
        >
          {feedback.ok ? feedback.message : feedback.error}
        </p>
      )}
    </section>
  );
}

/** 录入 API 地址、协议和密钥，已有密钥通过空白输入保留 */
function ConnectionForm({
  connection,
  pending,
  onSave,
  onCancel,
}: {
  connection?: Connection;
  pending: boolean;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const [protocol, setProtocol] = useState(connection?.protocol ?? 'chat-completions');

  return (
    <form
      method="post"
      onSubmit={onSave}
      className="rounded-lg border border-slate-200 bg-slate-50 p-3"
    >
      {connection && <input type="hidden" name="previousName" value={connection.name} />}
      <fieldset disabled={pending} className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-xs font-medium text-slate-700">
            连接名称
            <input
              className={control}
              name="name"
              defaultValue={connection?.name}
              maxLength={80}
              required
            />
          </label>
          <label className="text-xs font-medium text-slate-700">
            API 地址
            <input
              className={control}
              name="baseUrl"
              type="url"
              defaultValue={connection?.baseUrl}
              placeholder="https://api.example.com/v1"
              required
            />
          </label>
          <label className="text-xs font-medium text-slate-700">
            协议（OpenAI 兼容）
            <select
              className={control}
              name="protocol"
              value={protocol}
              onChange={(event) =>
                setProtocol(
                  event.currentTarget.value === 'responses' ? 'responses' : 'chat-completions',
                )
              }
            >
              <option value="chat-completions">Chat Completions</option>
              <option value="responses">Responses</option>
            </select>
          </label>
          {protocol === 'chat-completions' && (
            <label className="text-xs font-medium text-slate-700">
              JSON 输出
              <select
                className={control}
                name="jsonMode"
                defaultValue={connection?.jsonMode ?? 'json-object'}
              >
                <option value="json-object">JSON mode</option>
                <option value="prompt">通过提示词要求 JSON</option>
              </select>
            </label>
          )}
          <label className="text-xs font-medium text-slate-700">
            API 密钥
            <input
              className={control}
              name="apiKey"
              type="password"
              autoComplete="new-password"
              maxLength={16384}
              placeholder={connection?.hasCredential ? '留空保留当前密钥' : '服务无需认证时可留空'}
            />
          </label>
          {connection?.hasCredential && (
            <label className="flex items-end gap-2 pb-2 text-xs text-slate-700">
              <input name="clearApiKey" type="checkbox" /> 移除当前密钥
            </label>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className={secondary} onClick={onCancel}>
            取消
          </button>
          <button type="submit" className={primary}>
            {pending ? '保存中…' : '保存 API 连接'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
