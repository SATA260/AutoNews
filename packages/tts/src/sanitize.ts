/** 清理可能干扰语音合成的空白、括号内容和特殊符号。 */
export function sanitizeNarrationSentence(text: string): string {
  const cleaned = text
    .normalize('NFKC')
    .replace(/\([^()]*\)|（[^（）]*）|\[[^[\]]*\]|【[^【】]*】/g, '')
    .replace(/[~～♪♫\u200B-\u200D\uFEFF]/g, '')
    .replace(/…+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(?<=[\p{Script=Han}])\s+|\s+(?=[\p{Script=Han}])/gu, '')
    .replace(/[,，]+/g, '，')
    .replace(/[;；]/g, '，')
    .trim();
  if (!cleaned) return '';
  return /[。！？!?]$/.test(cleaned) ? cleaned : `${cleaned}。`;
}
