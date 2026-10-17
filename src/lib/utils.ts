/**
 * 轻量通用工具。
 *
 * 说明：原 `utils.ts` 把「图片 URL 处理 / HTML 清洗 / 播放源探测 / 超时配置」四类
 * 互不相关的关注点挤在一个模块里，导致任何引用者都要付出 `hls.js`（524KB）的代价。
 * 现已按职责拆分：
 *   - 图片：`@/lib/image-utils`
 *   - HTML：`@/lib/html-utils`
 *   - 播放源探测：`@/lib/video-probe`
 * 本文件只保留与请求超时相关的配置读取（无重型依赖）。
 */

/**
 * 获取配置的超时时间（秒）
 * 从 localStorage 读取，无效时回落到默认值
 */
export function getRequestTimeout(): number {
  if (typeof window === 'undefined') {
    return 30; // 服务器端返回默认值
  }

  try {
    const savedTimeout = localStorage.getItem('requestTimeout');
    if (savedTimeout) {
      const timeoutSeconds = parseInt(savedTimeout, 10);
      if (!isNaN(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= 60) {
        return timeoutSeconds;
      }
    }
  } catch (error) {
    console.warn('Failed to read timeout from localStorage:', error);
  }

  return 30; // 默认30秒
}
