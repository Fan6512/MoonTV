/**
 * 通用的豆瓣数据获取函数
 * @param url 请求的 URL
 * @param options 可选的 Next.js Data Cache 配置
 * @returns Promise<T> 返回指定类型的数据
 */
export interface DoubanFetchOptions {
  /**
   * 将上游响应缓存到 Next.js Data Cache 的秒数。
   * 未提供时保持调用方原有的缓存行为。
   */
  revalidate?: number;
}

export async function fetchDoubanData<T>(
  url: string,
  options: DoubanFetchOptions = {}
): Promise<T> {
  const revalidate = options.revalidate;

  if (
    revalidate !== undefined &&
    (!Number.isFinite(revalidate) || revalidate <= 0)
  ) {
    throw new RangeError('Douban cache revalidate must be a positive number');
  }

  // 添加超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 秒超时

  // 设置请求选项。只有显式传入 revalidate 的调用方才启用持久数据缓存。
  const fetchOptions = {
    signal: controller.signal,
    ...(revalidate === undefined
      ? {}
      : { next: { revalidate: Math.max(1, Math.floor(revalidate)) } }),
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      Referer: 'https://movie.douban.com/',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://movie.douban.com',
    },
  };

  try {
    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}
