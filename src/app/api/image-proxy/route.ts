import { NextResponse } from 'next/server';

import {
  createProxySignal,
  exceedsMaxBytes,
  IMAGE_PROXY_TIMEOUT_MS,
  isAllowedImageContentType,
  MAX_PROXIED_IMAGE_BYTES,
  readBoundedBody,
} from '@/lib/media-response';
import { fetchMediaUrl, validateMediaUrl } from '@/lib/url-guard';

export const runtime = 'edge';

/**
 * 所有失败分支一律 no-store：错误响应不能被 CDN 缓存半年，
 * 否则上游短暂故障 / 超时会在缓存期内持续返回坏图。
 */
function proxyError(error: string, status: number) {
  return NextResponse.json(
    { error },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
        'Vercel-CDN-Cache-Control': 'no-store',
      },
    }
  );
}

// OrionTV 兼容接口
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return proxyError('Missing image URL', 400);
  }

  // 图片代理使用独立的白名单（未配置时回退到视频白名单）
  const guard = validateMediaUrl(imageUrl, undefined, 'image');
  if (!guard.ok) {
    return proxyError(guard.reason || '地址不被允许', 403);
  }

  // 超时覆盖整个请求，包含响应体下载：慢速无界流必须在 15s 内被切断。
  const proxy = createProxySignal(request.signal, IMAGE_PROXY_TIMEOUT_MS);

  try {
    const imageResponse = await fetchMediaUrl(
      imageUrl,
      {
        signal: proxy.signal,
        headers: {
          Referer: 'https://movie.douban.com/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        },
      },
      'image'
    );

    if (!imageResponse.ok) {
      await imageResponse.body?.cancel();
      return proxyError(imageResponse.statusText, imageResponse.status);
    }

    const contentType = imageResponse.headers.get('content-type');

    // 默认拒绝 SVG 等 XML 图片：作为独立文档打开时可携带脚本，
    // 经同源代理后会带上站点源的权限，nosniff 不足以消除风险。
    if (!isAllowedImageContentType(contentType)) {
      await imageResponse.body?.cancel();
      return proxyError('Not an allowed image response', 415);
    }

    // 声明已超限就别拉流；没有 Content-Length 时由下面的缓冲读取兜底。
    if (exceedsMaxBytes(imageResponse.headers.get('content-length'))) {
      await imageResponse.body?.cancel();
      return proxyError('Image too large', 413);
    }

    if (!imageResponse.body) {
      return proxyError('Image response has no body', 500);
    }

    // 先完整读到上限再返回：这样无 Content-Length 的超限响应能真正回 413，
    // 慢速流超时能回 504，客户端 <img onError> 才有可靠的状态码可回退；
    // 也避免「200 + public, s-maxage 已发出、流中途断掉」被 CDN 缓存成坏图。
    const bounded = await readBoundedBody(
      imageResponse.body,
      MAX_PROXIED_IMAGE_BYTES
    );
    if (!bounded.ok) {
      return proxyError('Image too large', 413);
    }

    const headers = new Headers();
    headers.set('Content-Type', contentType || 'image/jpeg');
    // 准确的 Content-Length 让浏览器 / CDN 能识别任何传输层的截断
    headers.set('Content-Length', String(bounded.byteLength));
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cache-Control', 'public, max-age=15720000, s-maxage=15720000');
    headers.set('CDN-Cache-Control', 'public, s-maxage=15720000');
    headers.set('Vercel-CDN-Cache-Control', 'public, s-maxage=15720000');
    headers.set('Netlify-Vary', 'query');

    return new Response(bounded.bytes, { status: 200, headers });
  } catch {
    if (request.signal?.aborted) {
      return proxyError('Client closed the connection', 499);
    }
    if (proxy.timedOut) {
      return proxyError('Upstream image timed out', 504);
    }
    return proxyError('Error fetching image', 502);
  } finally {
    proxy.releaseTimeout();
  }
}
