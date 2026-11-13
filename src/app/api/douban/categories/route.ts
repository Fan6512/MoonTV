import { NextResponse } from 'next/server';

import { getCacheTime } from '@/lib/config';
import { fetchDoubanData } from '@/lib/douban';
import { DoubanItem, DoubanResult } from '@/lib/types';

interface DoubanCategoryApiResponse {
  total: number;
  items: Array<{
    id: string;
    title: string;
    card_subtitle: string;
    pic: {
      large: string;
      normal: string;
    };
    rating: {
      value: number;
    };
  }>;
}

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // 获取参数
  const kind = searchParams.get('kind') || 'movie';
  const category = searchParams.get('category');
  const type = searchParams.get('type');
  const pageLimit = parseInt(searchParams.get('limit') || '20');
  const pageStart = parseInt(searchParams.get('start') || '0');

  // 验证参数
  if (!kind || !category || !type) {
    return NextResponse.json(
      { error: '缺少必要参数: kind 或 category 或 type' },
      { status: 400 }
    );
  }

  if (!['tv', 'movie'].includes(kind)) {
    return NextResponse.json(
      { error: 'kind 参数必须是 tv 或 movie' },
      { status: 400 }
    );
  }

  if (pageLimit < 1 || pageLimit > 100) {
    return NextResponse.json(
      { error: 'pageSize 必须在 1-100 之间' },
      { status: 400 }
    );
  }

  if (pageStart < 0) {
    return NextResponse.json(
      { error: 'pageStart 不能小于 0' },
      { status: 400 }
    );
  }

  const target = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${kind}?start=${pageStart}&limit=${pageLimit}&category=${category}&type=${type}`;
  const requestStartedAt = performance.now();

  let configDuration = 0;
  let doubanDuration = 0;
  let transformDuration = 0;

  const getServerTiming = () =>
    [
      `config;dur=${configDuration.toFixed(1)}`,
      `douban;dur=${doubanDuration.toFixed(1)}`,
      `transform;dur=${transformDuration.toFixed(1)}`,
      `total;dur=${(performance.now() - requestStartedAt).toFixed(1)}`,
    ].join(', ');

  try {
    // 缓存 TTL 沿用站点现有配置；异常或无效值回退到原默认值 7200 秒。
    const configStartedAt = performance.now();
    let cacheTime = 7200;
    try {
      const configuredCacheTime = await getCacheTime();
      if (Number.isFinite(configuredCacheTime) && configuredCacheTime > 0) {
        cacheTime = Math.max(1, Math.floor(configuredCacheTime));
      }
    } finally {
      configDuration = performance.now() - configStartedAt;
    }

    // 上游响应进入 Next.js Data Cache；URL 只包含真实豆瓣查询参数，
    // 不包含浏览器侧用于制造 CDN MISS 的额外参数。
    const doubanStartedAt = performance.now();
    let doubanData: DoubanCategoryApiResponse;
    try {
      doubanData = await fetchDoubanData<DoubanCategoryApiResponse>(target, {
        revalidate: cacheTime,
      });
    } finally {
      doubanDuration = performance.now() - doubanStartedAt;
    }

    // 转换数据格式
    const transformStartedAt = performance.now();
    const list: DoubanItem[] = doubanData.items.map((item) => ({
      id: item.id,
      title: item.title,
      poster: item.pic?.normal || item.pic?.large || '',
      rate: item.rating?.value ? item.rating.value.toFixed(1) : '',
      year: item.card_subtitle?.match(/(\d{4})/)?.[1] || '',
    }));
    transformDuration = performance.now() - transformStartedAt;

    const response: DoubanResult = {
      code: 200,
      message: '获取成功',
      list: list,
    };

    return NextResponse.json(response, {
      headers: {
        'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
        'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        'Netlify-Vary': 'query',
        'Server-Timing': getServerTiming(),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: '获取豆瓣数据失败', details: (error as Error).message },
      {
        status: 500,
        headers: {
          'Server-Timing': getServerTiming(),
        },
      }
    );
  }
}
