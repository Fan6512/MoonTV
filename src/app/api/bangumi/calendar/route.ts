import { NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';

export const runtime = 'edge';

interface BangumiCalendarItem {
  id: number;
  name: string;
  name_cn: string;
  rating: {
    score: number;
  };
  air_date: string;
  images: {
    large: string;
    common: string;
    medium: string;
    small: string;
    grid: string;
  };
}

interface BangumiCalendarData {
  weekday: {
    en: string;
  };
  items: BangumiCalendarItem[];
}

function replaceImageUrl(
  data: BangumiCalendarData[],
  imageProxy: string
): BangumiCalendarData[] {
  // 无论是否配置图片代理，都要剔除 images 为 null 的条目：
  // Bangumi 的日历里确实存在没有封面的番剧（如 id 498559「Electro Andes」），
  // 原实现只在配置了代理时才过滤，未配代理时会把 null 原样下发给前端，
  // 前端 `anime.images.large` 直接抛 TypeError，整页白屏。
  return data.map((day) => ({
    ...day,
    items: (day.items || [])
      .filter((item) => item && item.images)
      .map((item) => {
        const replace = (url: string) =>
          typeof url === 'string' && imageProxy
            ? url.replace('https://lain.bgm.tv', imageProxy)
            : url || '';
        return {
          ...item,
          images: {
            large: replace(item.images.large),
            common: replace(item.images.common),
            medium: replace(item.images.medium),
            small: replace(item.images.small),
            grid: replace(item.images.grid),
          },
        };
      }),
  }));
}

export async function GET() {
  try {
    const config = await getConfig();
    const bangumiProxy =
      config.SiteConfig.BangumiProxy ||
      process.env.NEXT_PUBLIC_BANGUMI_PROXY ||
      '';
    const imageProxy =
      config.SiteConfig.BangumiImageProxy ||
      process.env.NEXT_PUBLIC_BANGUMI_IMAGE_PROXY ||
      '';

    const baseUrl = bangumiProxy
      ? bangumiProxy.replace(/\/+$/, '')
      : 'https://api.bgm.tv';

    const urls = bangumiProxy
      ? [`${baseUrl}/calendar`, 'https://api.bgm.tv/calendar']
      : ['https://api.bgm.tv/calendar'];

    let data: BangumiCalendarData[] = [];
    let lastError: unknown;

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'application/json',
          },
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const json = await response.json();
        if (Array.isArray(json)) {
          data = json as BangumiCalendarData[];
          break;
        }
      } catch (error) {
        lastError = error;
        continue;
      }
    }

    if (!data.length && lastError) {
      console.error('Bangumi 日历所有源均请求失败:', lastError);
    }

    const processed = replaceImageUrl(data, imageProxy.replace(/\/+$/, ''));

    return NextResponse.json(processed, {
      headers: {
        'Cache-Control': 'public, max-age=1800',
      },
    });
  } catch (error) {
    console.error('Bangumi 日历接口异常:', error);
    return NextResponse.json([], { status: 200 });
  }
}
