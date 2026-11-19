import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileJson,
  Plus,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { MASCOT_REGISTRY } from '../../mascots/mascotRegistry';
import {
  type DailyIssueInput,
  HARD_LIMITS,
  type MascotMode,
  type NewsItemInput,
  type PresetMascotId,
  type SanitizedDailyIssue,
  type ValidationWarning,
} from '../../schema/newsSchema';

/** 编辑与体检抽屉面板的标签页标识 */
export type InspectorTab = 'summary' | 'json' | 'health';

/** 编辑与体检抽屉组件的入参属性 */
interface DataInspectorDrawerProps {
  open: boolean;
  activeTab: InspectorTab;
  rawIssue: DailyIssueInput;
  sanitizedIssue: SanitizedDailyIssue;
  warnings: ValidationWarning[];
  runtimeErrors: string[];
  activeNewsItemIndex: number;
  onTabChange: (tab: InspectorTab) => void;
  onClose: () => void;
  onApplyRawData: (nextRaw: unknown) => void;
  onResetSample: () => void;
  onJumpToNewsPage: (itemIndex: number) => void;
}

/** 深拷贝整期输入数据以便安全修改表单 */
function cloneIssue(issue: DailyIssueInput): DailyIssueInput {
  return JSON.parse(JSON.stringify(issue)) as DailyIssueInput;
}

/** 编辑与校验抽屉面板：支持逐条编辑梗概与配图、粘贴整期 JSON，以及查看自动修正体检结果 */
export const DataInspectorDrawer: React.FC<DataInspectorDrawerProps> = ({
  open,
  activeTab,
  rawIssue,
  sanitizedIssue,
  warnings,
  runtimeErrors,
  activeNewsItemIndex,
  onTabChange,
  onClose,
  onApplyRawData,
  onResetSample,
  onJumpToNewsPage,
}) => {
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [jsonText, setJsonText] = useState<string>('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (activeNewsItemIndex >= 0 && activeNewsItemIndex < sanitizedIssue.items.length) {
      setSelectedIdx(activeNewsItemIndex);
    }
  }, [activeNewsItemIndex, sanitizedIssue.items.length]);

  useEffect(() => {
    if (open) {
      setJsonText(JSON.stringify(rawIssue, null, 2));
      setJsonError(null);
    }
  }, [open, rawIssue]);

  if (!open) {
    return null;
  }

  const rawItems: NewsItemInput[] = Array.isArray(rawIssue.items) ? rawIssue.items : [];
  const safeIdx = Math.min(Math.max(0, selectedIdx), Math.max(0, rawItems.length - 1));
  const currentItem: NewsItemInput = rawItems[safeIdx] ?? {
    title: '',
    summary: '',
  };

  const updateIssuePatch = (patch: Partial<DailyIssueInput>) => {
    const next = { ...cloneIssue(rawIssue), ...patch };
    onApplyRawData(next);
  };

  const updateCurrentItem = (patch: Partial<NewsItemInput>) => {
    const next = cloneIssue(rawIssue);
    if (!Array.isArray(next.items)) {
      next.items = [];
    }
    const existing = next.items[safeIdx] ?? { title: '', summary: '' };
    next.items[safeIdx] = { ...existing, ...patch };
    onApplyRawData(next);
  };

  const handleAddNewsItem = () => {
    const next = cloneIssue(rawIssue);
    if (!Array.isArray(next.items)) {
      next.items = [];
    }
    if (next.items.length >= HARD_LIMITS.maxItems) {
      return;
    }
    const nextNum = next.items.length + 1;
    next.items.push({
      id: `news-${String(nextNum).padStart(2, '0')}`,
      category: '新资讯',
      entity: 'OpenAI',
      shortTitle: `新增 AI 动态 #${nextNum}`,
      progressLabel: `AI动态#${nextNum}`,
      title: `新增 AI 动态 #${nextNum}：请填写标题`,
      summary: '填入简短的新闻事实梗概（建议 35~80 字），画面不展示主持人长篇口播稿。',
      cards: [
        {
          icon: 'rocket',
          title: '核心发布',
          body: '在这里填入核心发布内容，概括该项 AI 进展的主要看点与定位。',
        },
        {
          icon: 'cpu',
          title: '技术规格',
          body: '补充参数规模、上下文长度、延迟表现或其他关键技术指标。',
        },
        {
          icon: 'cloud',
          title: '平台与入口',
          body: '说明支持的访问平台、客户端、开发接口或开源仓库地址。',
        },
        {
          icon: 'shield',
          title: '适用范围',
          body: '明确免费额度、付费门槛、区域或内测时间等当前真实使用限制。',
        },
      ],
      keyPoints: ['要点一：简述核心发布内容', '要点二：说明实际影响或边界'],
      officialQuote: '未配置官方图片时，右侧将自动展示此原文摘录与关键参数表格。',
      source: '官方发布',
      mascotId: sanitizedIssue.hostMascotId,
      durationSec: 8,
    });
    const newIndex = next.items.length - 1;
    onApplyRawData(next);
    setSelectedIdx(newIndex);
    onJumpToNewsPage(newIndex);
  };

  const handleApplyJson = () => {
    try {
      const parsed: unknown = JSON.parse(jsonText);
      setJsonError(null);
      onApplyRawData(parsed);
    } catch (err) {
      setJsonError(err instanceof Error ? `JSON 语法错误：${err.message}` : 'JSON 语法无法解析');
    }
  };

  const handleCopyJson = async () => {
    const serialized = JSON.stringify(rawIssue, null, 2);
    try {
      await navigator.clipboard.writeText(serialized);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setJsonText(serialized);
      onTabChange('json');
    }
  };

  const titleLen = Array.from(currentItem.title ?? '').length;
  const entityLen = Array.from(currentItem.entity ?? '').length;
  const shortTitleLen = Array.from(currentItem.shortTitle ?? '').length;
  const progressLabelLen = Array.from(currentItem.progressLabel ?? '').length;
  const summaryLen = Array.from(currentItem.summary ?? '').length;
  const captionLen = Array.from(currentItem.imageCaption ?? '').length;

  return (
    <div
      className="inspector-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="日报编辑与防错检查台"
    >
      <div className="inspector-drawer">
        <div className="inspector-header">
          <div className="inspector-title-wrap">
            <SlidersHorizontal size={17} />
            <h2>AI 每日报 · 梗概编辑与数据校验台</h2>
          </div>
          <div className="inspector-header-actions">
            <button type="button" className="inspector-mini-btn" onClick={handleCopyJson}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              <span>{copied ? '已复制 JSON' : '复制本期 JSON'}</span>
            </button>
            <button type="button" className="inspector-mini-btn" onClick={onResetSample}>
              <RotateCcw size={15} />
              <span>恢复示范数据</span>
            </button>
            <button
              type="button"
              className="inspector-close-btn"
              onClick={onClose}
              aria-label="关闭编辑抽屉"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="inspector-tabs">
          <button
            type="button"
            className={`inspector-tab ${activeTab === 'summary' ? 'is-active' : ''}`}
            onClick={() => onTabChange('summary')}
          >
            <SlidersHorizontal size={15} />
            <span>梗概、官方配图与角标</span>
          </button>
          <button
            type="button"
            className={`inspector-tab ${activeTab === 'json' ? 'is-active' : ''}`}
            onClick={() => onTabChange('json')}
          >
            <FileJson size={15} />
            <span>JSON 批量导入</span>
          </button>
          <button
            type="button"
            className={`inspector-tab ${activeTab === 'health' ? 'is-active' : ''}`}
            onClick={() => onTabChange('health')}
          >
            <ShieldCheck size={15} />
            <span>防错体检 ({warnings.length + runtimeErrors.length})</span>
          </button>
        </div>

        <div className="inspector-body">
          {activeTab === 'summary' && (
            <div className="summary-editor-layout">
              {/* Issue-level Mascot Behavior */}
              <div className="editor-form-grid">
                <label className="editor-field">
                  <div className="field-label-row">
                    <span>右下角 AI 娘模式</span>
                  </div>
                  <select
                    value={sanitizedIssue.mascotMode}
                    onChange={(e) => updateIssuePatch({ mascotMode: e.target.value as MascotMode })}
                  >
                    <option value="per-item">按当前新闻切换对应 AI 娘</option>
                    <option value="fixed-host">全期固定使用主讲角色</option>
                  </select>
                </label>

                <label className="editor-field">
                  <div className="field-label-row">
                    <span>封面/默认主讲角色</span>
                  </div>
                  <select
                    value={sanitizedIssue.hostMascotId}
                    onChange={(e) =>
                      updateIssuePatch({ hostMascotId: e.target.value as PresetMascotId })
                    }
                  >
                    {Object.values(MASCOT_REGISTRY).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="summary-item-pills">
                {sanitizedIssue.items.map((item, idx) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`summary-item-pill ${safeIdx === idx ? 'is-active' : ''}`}
                    onClick={() => {
                      setSelectedIdx(idx);
                      onJumpToNewsPage(idx);
                    }}
                  >
                    <span>#{item.indexLabel}</span>
                    <span className="pill-cat">{item.category}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className="summary-add-btn"
                  onClick={handleAddNewsItem}
                  disabled={rawItems.length >= HARD_LIMITS.maxItems}
                  title={`每期最多 ${HARD_LIMITS.maxItems} 条新闻`}
                >
                  <Plus size={15} />
                  <span>新增条目</span>
                </button>
              </div>

              <div className="editor-form-grid">
                <label className="editor-field full-span">
                  <div className="field-label-row">
                    <span>新闻主标题</span>
                    <span className={`char-count ${titleLen > HARD_LIMITS.title ? 'is-over' : ''}`}>
                      {titleLen} / {HARD_LIMITS.title}
                    </span>
                  </div>
                  <input
                    type="text"
                    value={currentItem.title ?? ''}
                    onChange={(e) => updateCurrentItem({ title: e.target.value })}
                    placeholder="输入简明事实性标题"
                  />
                </label>

                <label className="editor-field full-span">
                  <div className="field-label-row">
                    <span>所属公司 / 主体（用于开头瀑布流归组与 Logo 匹配）</span>
                    <span
                      className={`char-count ${entityLen > HARD_LIMITS.entity ? 'is-over' : ''}`}
                    >
                      {entityLen} / {HARD_LIMITS.entity}
                    </span>
                  </div>
                  <input
                    type="text"
                    value={currentItem.entity ?? ''}
                    onChange={(e) => updateCurrentItem({ entity: e.target.value })}
                    placeholder="例如：OpenAI、Google DeepMind、腾讯混元"
                  />
                </label>

                <label className="editor-field full-span">
                  <div className="field-label-row">
                    <span>封面目录短标题（留空将自动截取主标题）</span>
                    <span
                      className={`char-count ${shortTitleLen > HARD_LIMITS.shortTitle ? 'is-over' : ''}`}
                    >
                      {shortTitleLen} / {HARD_LIMITS.shortTitle}
                    </span>
                  </div>
                  <input
                    type="text"
                    value={currentItem.shortTitle ?? ''}
                    onChange={(e) => updateCurrentItem({ shortTitle: e.target.value })}
                    placeholder="例如：DeepSeek 新一代推理架构开源"
                  />
                </label>

                <label className="editor-field full-span">
                  <div className="field-label-row">
                    <span>顶部进度条极简总结（建议 6~10 字，留空自动截取短标题）</span>
                    <span
                      className={`char-count ${progressLabelLen > HARD_LIMITS.progressLabel ? 'is-over' : ''}`}
                    >
                      {progressLabelLen} / {HARD_LIMITS.progressLabel}
                    </span>
                  </div>
                  <input
                    type="text"
                    value={currentItem.progressLabel ?? ''}
                    onChange={(e) => updateCurrentItem({ progressLabel: e.target.value })}
                    placeholder="例如：DeepSeek推理降本"
                  />
                </label>

                <label className="editor-field full-span">
                  <div className="field-label-row">
                    <span>新闻简短梗概（左侧正文展示，非口播台词）</span>
                    <span
                      className={`char-count ${summaryLen > HARD_LIMITS.summary ? 'is-over' : ''}`}
                    >
                      {summaryLen} / {HARD_LIMITS.summary}
                    </span>
                  </div>
                  <textarea
                    rows={3}
                    value={currentItem.summary ?? ''}
                    onChange={(e) => updateCurrentItem({ summary: e.target.value })}
                    placeholder="简明扼要概括核心事实与影响边界"
                  />
                </label>

                <label className="editor-field full-span">
                  <div className="field-label-row">
                    <span>官方配图链接 / 本地路径（留空或失效则显示官方摘录表）</span>
                  </div>
                  <input
                    type="text"
                    value={currentItem.imageUrl ?? ''}
                    onChange={(e) => updateCurrentItem({ imageUrl: e.target.value.trim() || null })}
                    placeholder="/media/official-deepseek-report.svg"
                  />
                </label>

                <label className="editor-field full-span">
                  <div className="field-label-row">
                    <span>官方配图引用说明</span>
                    <span
                      className={`char-count ${captionLen > HARD_LIMITS.imageCaption ? 'is-over' : ''}`}
                    >
                      {captionLen} / {HARD_LIMITS.imageCaption}
                    </span>
                  </div>
                  <input
                    type="text"
                    value={currentItem.imageCaption ?? ''}
                    onChange={(e) => updateCurrentItem({ imageCaption: e.target.value })}
                    placeholder="图｜DeepSeek 技术报告基准测试"
                  />
                </label>

                <label className="editor-field">
                  <div className="field-label-row">
                    <span>本条右下角 AI 娘</span>
                  </div>
                  <select
                    value={(currentItem.mascotId ?? sanitizedIssue.hostMascotId).toLowerCase()}
                    onChange={(e) =>
                      updateCurrentItem({ mascotId: e.target.value as PresetMascotId })
                    }
                  >
                    {Object.values(MASCOT_REGISTRY).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="editor-field">
                  <div className="field-label-row">
                    <span>停留/配音时长（秒，支持小数）</span>
                  </div>
                  <input
                    type="number"
                    step="0.1"
                    min={HARD_LIMITS.minDurationSec}
                    max={HARD_LIMITS.maxItemDurationSec}
                    value={currentItem.durationSec ?? HARD_LIMITS.defaultItemDurationSec}
                    onChange={(e) => updateCurrentItem({ durationSec: Number(e.target.value) })}
                  />
                </label>
              </div>
            </div>
          )}

          {activeTab === 'json' && (
            <div className="json-editor-wrap">
              <p className="json-editor-hint">
                可在此直接粘贴自动化工作流产出的日报
                JSON。即使存在缺字段、超长文本或无效图片链接，防错引擎也会自动清洗并保证画面零报错。
              </p>
              {jsonError && (
                <div className="json-syntax-alert" role="alert">
                  <AlertTriangle size={16} />
                  <span>{jsonError}</span>
                </div>
              )}
              <textarea
                className="json-textarea"
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                spellCheck={false}
              />
              <div className="json-editor-actions">
                <button type="button" className="apply-json-btn" onClick={handleApplyJson}>
                  <CheckCircle2 size={16} />
                  <span>应用并执行安全校验</span>
                </button>
              </div>
            </div>
          )}

          {activeTab === 'health' && (
            <div className="health-panel">
              <div
                className={`health-summary-box ${
                  warnings.length + runtimeErrors.length === 0 ? 'is-clean' : 'is-warn'
                }`}
              >
                {warnings.length + runtimeErrors.length === 0 ? (
                  <>
                    <CheckCircle2 size={22} />
                    <div>
                      <strong>所有页面与文案均通过硬限制检查</strong>
                      <p>
                        当前共 {sanitizedIssue.items.length + 2}{' '}
                        页，字数、媒体链接、角色配置与运行边界均保持 100% 洁净状态。
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <AlertTriangle size={22} />
                    <div>
                      <strong>
                        已自动兜底修正 {warnings.length} 项数据问题 · 运行异常{' '}
                        {runtimeErrors.length} 项
                      </strong>
                      <p>
                        模板已在渲染前自动执行截断或默认值替换，成片画面绝不会出现错误提示或布局崩坏。
                      </p>
                    </div>
                  </>
                )}
              </div>

              {runtimeErrors.length > 0 && (
                <div className="health-list">
                  <h4>局部渲染隔离记录</h4>
                  {runtimeErrors.map((err, idx) => (
                    <div key={idx} className="health-item is-error">
                      <code>runtime</code>
                      <span>{err}</span>
                    </div>
                  ))}
                </div>
              )}

              {warnings.length > 0 && (
                <div className="health-list">
                  <h4>数据安全修正明细</h4>
                  {warnings.map((w, idx) => (
                    <div key={idx} className="health-item">
                      <code>{w.path}</code>
                      <span>{w.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
