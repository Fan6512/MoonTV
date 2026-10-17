/**
 * 图片 URL 处理（纯浏览器工具，零重型依赖）。
 *
 * 从 `utils.ts` 拆出的原因：`processImageUrl` 被 VideoCard / 详情面板等高频繁组件引用，
 * 而原模块同时静态引入了 `hls.js`（524KB）。模块边界不清会让播放库泄漏进全站首包。
 */

function getDoubanImageProxyConfig(): {
  proxyType:
    | 'direct'
    | 'server'
    | 'img3'
    | 'cmliussss-cdn-tencent'
    | 'cmliussss-cdn-ali'
    | 'custom';
  proxyUrl: string;
} {
  const doubanImageProxyType =
    localStorage.getItem('doubanImageProxyType') ||
    (window as any).RUNTIME_CONFIG?.DOUBAN_IMAGE_PROXY_TYPE ||
    'direct';
  const doubanImageProxy =
    localStorage.getItem('doubanImageProxyUrl') ||
    (window as any).RUNTIME_CONFIG?.DOUBAN_IMAGE_PROXY ||
    '';
  return {
    proxyType: doubanImageProxyType,
    proxyUrl: doubanImageProxy,
  };
}

/**
 * 处理图片 URL，如果设置了图片代理则使用代理
 */
export function processImageUrl(originalUrl: string): string {
  if (!originalUrl) return originalUrl;

  const normalizedUrl = originalUrl.trim();

  // 已经是本地代理、内联资源或本地资源时，直接返回
  if (
    normalizedUrl.startsWith('/api/image-proxy?url=') ||
    normalizedUrl.startsWith('data:') ||
    normalizedUrl.startsWith('blob:') ||
    normalizedUrl.startsWith('/')
  ) {
    return normalizedUrl;
  }

  // HTTPS 页面下直接加载 http 图片会触发 Mixed Content，统一走服务端代理兜底
  if (normalizedUrl.startsWith('http://')) {
    return `/api/image-proxy?url=${encodeURIComponent(normalizedUrl)}`;
  }

  // 仅处理豆瓣图片代理
  if (!normalizedUrl.includes('doubanio.com')) {
    return normalizedUrl;
  }

  const { proxyType, proxyUrl } = getDoubanImageProxyConfig();
  switch (proxyType) {
    case 'server':
      return `/api/image-proxy?url=${encodeURIComponent(normalizedUrl)}`;
    case 'img3':
      return normalizedUrl.replace(
        /img\d+\.doubanio\.com/g,
        'img3.doubanio.com'
      );
    case 'cmliussss-cdn-tencent':
      return normalizedUrl.replace(
        /img\d+\.doubanio\.com/g,
        'img.doubanio.cmliussss.net'
      );
    case 'cmliussss-cdn-ali':
      return normalizedUrl.replace(
        /img\d+\.doubanio\.com/g,
        'img.doubanio.cmliussss.com'
      );
    case 'custom':
      return `${proxyUrl}${encodeURIComponent(normalizedUrl)}`;
    case 'direct':
    default:
      return normalizedUrl;
  }
}
