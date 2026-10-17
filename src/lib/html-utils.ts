/**
 * HTML 文本清洗（纯函数，可在服务端使用）。
 *
 * 与 `image-utils` / `video-probe` 分开的原因：本函数被 `lib/downstream.ts` 在
 * API Route（服务端）中调用，不应连带把浏览器专用的播放库拖进服务端包。
 */
import he from 'he';

export function cleanHtmlTags(text: string): string {
  if (!text) return '';

  const cleanedText = text
    .replace(/<[^>]+>/g, '\n') // 将 HTML 标签替换为换行
    .replace(/\n+/g, '\n') // 将多个连续换行合并为一个
    .replace(/[ \t]+/g, ' ') // 将多个连续空格和制表符合并为一个空格，但保留换行符
    .replace(/^\n+|\n+$/g, '') // 去掉首尾换行
    .trim(); // 去掉首尾空格

  // 使用 he 库解码 HTML 实体
  return he.decode(cleanedText);
}
