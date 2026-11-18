/*
 * AI 每日报视频封面模板脚本。
 * 对外提供 window.__COVER__：
 *   setData(data)      写入封面文字与主播信息并重新排版
 *   waitUntilReady()   等待字体、立绘加载完成和排版稳定，返回 { ok, warnings }
 * 直接用浏览器打开时，可以用地址参数快速填字：
 *   index.html?title=GPT-6*翻车了*&subtitle=一句话钩子&host=gemini
 */
(() => {
  'use strict';

  /** 每位主播立绘在画布中的摆放位置（单位 px），全身立绘放大只露出上半身，Q 版立绘完整显示 */
  const MASCOT_LAYOUT = {
    gemini: { height: 1900, left: 1080, top: -10 },
    gpt: { height: 1900, left: 1080, top: -10 },
    claude: { height: 1900, left: 1080, top: -10 },
    deepseek: { height: 1180, left: 1010, top: -10 },
  };

  /** 未指定立绘位置时的默认摆放 */
  const DEFAULT_LAYOUT = { height: 1900, left: 1080, top: -10 };

  /** 主播显示名默认值 */
  const HOST_NAMES = {
    deepseek: '聪明的大肥鱼',
    gpt: 'gpt',
    gemini: '哈基米',
    claude: '小克',
  };

  /** 直接打开页面预览时使用的示例数据 */
  const SAMPLE = {
    title: 'GPT-6.2 *翻车了*',
    subtitle: '成本砍到三分之一，却被差评淹没',
    masthead: 'AI 每日报',
    date: '11月18日 周三',
    issueNumber: 'VOL.2026.11.18',
    hostId: 'gemini',
    hostName: '哈基米',
    mascotUrl: '../../assets/mascots/gemini.png',
  };

  const el = {
    root: document.getElementById('cover'),
    masthead: document.getElementById('masthead'),
    date: document.getElementById('date'),
    issue: document.getElementById('issue'),
    title: document.getElementById('title'),
    subtitle: document.getElementById('subtitle'),
    mascot: document.getElementById('mascot'),
    sticker: document.getElementById('host-sticker'),
    hostName: document.getElementById('host-name'),
  };

  let warnings = [];
  let mascotPromise = Promise.resolve();
  let layoutPromise = Promise.resolve();

  /** 把任意输入转成去掉首尾空白的字符串 */
  function str(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  /** 英文、数字组成的连续词（如 Qwen4-Max、GPT-6.2、o3-mini） */
  const LATIN_WORD = /[A-Za-z0-9][A-Za-z0-9.+\-_/]*[A-Za-z0-9+]|[A-Za-z0-9]/g;

  /** 把一段纯文字追加到父节点：英文词包成不换行的整体，换行符转成强制换行 */
  function appendPlainText(parent, text) {
    const lines = text.split(/\\n|\n/);
    lines.forEach((line, lineIdx) => {
      if (lineIdx > 0) parent.appendChild(document.createElement('br'));
      let last = 0;
      for (const match of line.matchAll(LATIN_WORD)) {
        const start = match.index ?? 0;
        if (start > last) parent.appendChild(document.createTextNode(line.slice(last, start)));
        const word = document.createElement('span');
        word.className = 'nobr';
        word.textContent = match[0];
        parent.appendChild(word);
        last = start + match[0].length;
      }
      if (last < line.length) parent.appendChild(document.createTextNode(line.slice(last)));
    });
  }

  /**
   * 把标题文字写入标题节点：用 *星号* 包住的重点词显示为主题色，
   * 英文词不会在连字符处被拆到两行，全程用文本节点写入，不解析任何 HTML。
   */
  function renderTitle(node, raw) {
    node.textContent = '';
    const parts = raw.split(/\*([^*\n]+)\*/);
    parts.forEach((part, idx) => {
      const text = part.replace(/\*/g, '');
      if (!text) return;
      if (idx % 2 === 1) {
        const hl = document.createElement('span');
        hl.className = 'hl';
        appendPlainText(hl, text);
        node.appendChild(hl);
      } else {
        appendPlainText(node, text);
      }
    });
  }

  /** 计算元素当前实际排成了几行（按内容区高度除以行高，不受大字号字形外溢影响） */
  function countLines(node) {
    const cs = getComputedStyle(node);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    const contentHeight =
      node.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    return Math.round(contentHeight / lineHeight);
  }

  /**
   * 从最大字号开始逐步缩小，直到文字不超过指定行数、不溢出宽度且不超过限定高度。
   * 能放下时返回 true；缩到最小字号仍放不下时返回 false。
   */
  function fitText(node, opts) {
    const { max, min, maxLines, step, maxHeight } = opts;
    let size = max;
    for (;;) {
      node.style.fontSize = `${size}px`;
      const fitsLines = countLines(node) <= maxLines;
      const fitsWidth = node.scrollWidth <= node.clientWidth + 1;
      const fitsHeight = maxHeight === undefined || node.offsetHeight <= maxHeight;
      if (fitsLines && fitsWidth && fitsHeight) return true;
      if (size <= min) return false;
      size = Math.max(min, size - step);
    }
  }

  /** 按当前文字重新计算标题与副标题字号：副标题优先排成一行，太长时才允许两行；主标题优先两行，太长时才允许三行 */
  function layout() {
    const oneLine = fitText(el.subtitle, { max: 64, min: 50, maxLines: 1, step: 2 });
    if (!oneLine && !fitText(el.subtitle, { max: 54, min: 40, maxLines: 2, step: 2 })) {
      warnings.push('副标题文字过长，最小字号下仍超过两行');
    }
    const box = el.title.parentElement;
    const maxHeight = box ? box.clientHeight : undefined;
    const twoLines = fitText(el.title, { max: 210, min: 120, maxLines: 2, step: 4, maxHeight });
    if (!twoLines) {
      const threeLines = fitText(el.title, { max: 150, min: 90, maxLines: 3, step: 4, maxHeight });
      if (!threeLines) warnings.push('主标题文字过长，最小字号下仍放不下');
    }
  }

  /** 加载主播立绘并按主播摆放；加载失败时隐藏立绘区域 */
  function applyMascot(hostId, url) {
    const spec = MASCOT_LAYOUT[hostId] || DEFAULT_LAYOUT;
    el.mascot.style.height = `${spec.height}px`;
    el.mascot.style.left = `${spec.left}px`;
    el.mascot.style.top = `${spec.top}px`;
    el.mascot.classList.remove('is-missing');
    if (!url) {
      el.mascot.removeAttribute('src');
      el.mascot.classList.add('is-missing');
      warnings.push('未提供主播立绘');
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      el.mascot.onload = () => {
        const decode = el.mascot.decode ? el.mascot.decode() : Promise.resolve();
        decode.catch(() => undefined).then(resolve);
      };
      el.mascot.onerror = () => {
        el.mascot.classList.add('is-missing');
        warnings.push(`主播立绘加载失败: ${url}`);
        resolve();
      };
      el.mascot.src = url;
    });
  }

  /** 写入封面数据并重新排版 */
  function setData(input) {
    const data = input && typeof input === 'object' ? input : {};
    warnings = [];
    const hostId = str(data.hostId) in MASCOT_LAYOUT ? str(data.hostId) : 'gemini';
    el.root.dataset.host = hostId;

    el.masthead.textContent = str(data.masthead) || 'AI 每日报';
    el.date.textContent = str(data.date);
    el.issue.textContent = str(data.issueNumber);

    const title = str(data.title);
    if (!title) warnings.push('缺少主标题');
    renderTitle(el.title, title);
    el.subtitle.textContent = str(data.subtitle);

    const hostName = str(data.hostName) || HOST_NAMES[hostId] || '';
    el.hostName.textContent = hostName;
    el.sticker.classList.toggle('is-hidden', !hostName);

    mascotPromise = applyMascot(hostId, str(data.mascotUrl));
    const fontsReady = document.fonts ? document.fonts.ready : Promise.resolve();
    layoutPromise = fontsReady.then(() => layout());
  }

  /** 等待两帧，确保浏览器已经完成绘制 */
  function nextFrames() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }

  /** 等待字体、立绘与排版全部完成 */
  async function waitUntilReady() {
    await Promise.all([mascotPromise, layoutPromise]);
    await nextFrames();
    return { ok: !warnings.some((w) => w.startsWith('缺少')), warnings: warnings.slice() };
  }

  window.__COVER__ = { setData, waitUntilReady };

  // 直接打开页面时：优先读取地址参数，否则显示示例数据
  if (!window.__COVER_EXTERNAL__) {
    const params = new URLSearchParams(window.location.search);
    if (params.get('external') !== '1') {
      const host = params.get('host') || SAMPLE.hostId;
      setData({
        ...SAMPLE,
        title: params.get('title') ?? SAMPLE.title,
        subtitle: params.get('subtitle') ?? SAMPLE.subtitle,
        date: params.get('date') ?? SAMPLE.date,
        issueNumber: params.get('issue') ?? SAMPLE.issueNumber,
        hostId: host,
        hostName: params.get('hostName') ?? HOST_NAMES[host] ?? '',
        mascotUrl: params.get('mascot') ?? `../../assets/mascots/${host}.png`,
      });
    }
  }
})();
