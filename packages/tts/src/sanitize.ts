/** 清理单句口播文本中可能引发语音停顿或发音异常的多余空格、括号注释和干扰符号 */
export function sanitizeNarrationSentence(text: string): string {
  const cleaned = text
    .normalize('NFKC')
    .replace(/\([^()]*\)|（[^（）]*）|\[[^[\]]*\]|【[^【】]*】/g, '')
    .replace(/[~～♪♫\u200B-\u200D\uFEFF]/g, '')
    .replace(/…+/g, '')
    .replace(/—+|-{2,}/g, '，')
    .replace(/[\s\u00A0\u3000]+/g, ' ')
    .trim()
    .replace(/(?<![A-Za-z]) | (?![A-Za-z])/g, '')
    .replace(/[,，]+/g, '，')
    .replace(/[;；]+/g, '，')
    .replace(/(?<!\d)[:：]+|[:：]+(?!\d)/g, '，')
    .replace(/，+/g, '，')
    .replace(/^[，、。！？!?]+/, '')
    .replace(/[，、]+$/, '')
    .trim();
  if (!cleaned) return '';
  return /[。！？!?]$/.test(cleaned) ? cleaned : `${cleaned}。`;
}

/** 将可能包含多句口播的长文本按中文终结标点拆分为单句数组，保留小数点等数字内部符号 */
function splitRawSentences(raw: string): string[] {
  return raw
    .split(/(?<=[。！？!?]+)(?![。！？!?])\s*/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 将原始口播文本拆分为经过清理、适合单句朗读与字幕展示的非空分句列表 */
export function prepareNarrationSentences(sentences: readonly string[]): string[] {
  return sentences
    .flatMap((entry) => splitRawSentences(entry))
    .map((sentence) => sanitizeNarrationSentence(sentence))
    .filter((sentence) => sentence.length > 0);
}

/** 将同一段落的多句口播清洗掉句内冗余空格，并按句用单个空格拼接为整段文本送入语音模型 */
export function buildNarrationParagraph(sentences: readonly string[]): string {
  return prepareNarrationSentences(sentences).join(' ').trim();
}
