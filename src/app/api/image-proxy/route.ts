import { NextResponse } from 'next/server';

import {
  createProxySignal,
  createSizeLimitedStream,
  exceedsMaxBytes,
  IMAGE_PROXY_TIMEOUT_MS,
  isAllowedImageContentType,
} from '@/lib/media-response';
import { fetchMediaUrl, validateMediaUrl } from '@/lib/url-guard';

export const runtime = 'edge';

// OrionTV 兼容接口
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
  }

  // 图片代理使用独立的白名单（未配置时回退到视频白名单）
  const guard = validateMediaUrl(imageUrl, undefined, 'image');
  if (!guard.ok) {
    return NextResponse.json({ error: guard.reason }, { status: 403 });
  }

  try {
    const { signal } = createProxySignal(
      request.signal,
      IMAGE_PROXY_TIMEOUT_MS
    );
    const imageResponse = await fetchMediaUrl(
      imageUrl,
      {
        signal,
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
      return NextResponse.json(
        { error: imageResponse.statusText },
        { status: imageResponse.status }
      );
    }

    const contentType = imageResponse.headers.get('content-type');

    // 默认拒绝 SVG 等 XML 图片：作为独立文档打开时可携带脚本，
    // 经同源代理后会带上站点源的权限，nosniff 不足以消除风险。
    if (!isAllowedImageContentType(contentType)) {
      await imageResponse.body?.cancel();
      return NextResponse.json(
        { error: 'Not an allowed image response' },
        { status: 415 }
      );
    }

    // 声明已超限就别拉流；没有 Content-Length 时由下面的流式计数兜底。
    if (exceedsMaxBytes(imageResponse.headers.get('content-length'))) {
      await imageResponse.body?.cancel();
      return NextResponse.json({ error: 'Image too large' }, { status: 413 });
    }

    if (!imageResponse.body) {
      return NextResponse.json(
        { error: 'Image response has no body' },
        { status: 500 }
      );
    }

    // 创建响应头
    const headers = new Headers();
    headers.set('Content-Type', contentType || 'image/jpeg');
    headers.set('X-Content-Type-Options', 'nosniff');

    // 设置缓存头（可选）
    headers.set('Cache-Control', 'public, max-age=15720000, s-maxage=15720000'); // 缓存半年
    headers.set('CDN-Cache-Control', 'public, s-maxage=15720000');
    headers.set('Vercel-CDN-Cache-Control', 'public, s-maxage=15720000');
    headers.set('Netlify-Vary', 'query');

    // 逐块转发并累计字节数，超限立即切断上游，避免无界流吃满带宽
    return new Response(createSizeLimitedStream(imageResponse.body), {
      status: 200,
      headers,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Error fetching image' },
      { status: 500 }
    );
  }
}
