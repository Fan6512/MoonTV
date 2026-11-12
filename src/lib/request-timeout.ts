/**
 * 请求超时配置读取（轻量，零重型依赖）。
 *
 * 从 `utils.ts` 拆出：SourceSelector 经 layout → ConditionalNav → TopNav 进入
 * root layout 的 chunk 组，此处若与播放探测同模块，会让 hls.js 进入全站首包。
 */

/* eslint-disable no-console */

/**
 * 获取配置的超时时间（秒）
 * 从 localStorage 读取，如果不存在或无效则返回默认值30秒
 */
export function getRequestTimeout(): number {
  if (typeof window === 'undefined') {
    return 30; // 服务器端返回默认值
  }

  try {
    const savedTimeout = localStorage.getItem('requestTimeout');
    if (savedTimeout) {
      const timeoutSeconds = parseInt(savedTimeout, 10);
      if (
        !isNaN(timeoutSeconds) &&
        timeoutSeconds >= 1 &&
        timeoutSeconds <= 60
      ) {
        return timeoutSeconds;
      }
    }
  } catch (error) {
    console.warn('Failed to read timeout from localStorage:', error);
  }

  return 30; // 默认30秒
}
