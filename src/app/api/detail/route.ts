import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { fetchBangumiSubjectDetail } from '@/lib/bangumi';
import { getAvailableApiSites, getCacheTime } from '@/lib/config';
import { fetchDoubanData } from '@/lib/douban';
import { getDetailFromApi, searchFromApiStream } from '@/lib/downstream';

export const runtime = 'edge';

/**
 * 详情响应的缓存策略。
 *
 * 本地存储模式没有用户组概念，响应只由 URL 决定，可以走共享缓存。
 * 其它存储模式下响应取决于请求者所属的组（可用源不同），必须禁止共享缓存，
 * 否则受限用户可以直接命中 CDN 上由其它组用户产生的缓存，绕过源权限。
 */
function buildCacheHeaders(
  cacheTime: number,
  shareable = true
): Record<string, string> {
  if (!shareable) {
    return {
      'Cache-Control': `private, max-age=${cacheTime}`,
      Vary: 'Cookie',
      'CDN-Cache-Control': 'private, no-store',
      'Vercel-CDN-Cache-Control': 'private, no-store',
    };
  }
  return {
    'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
    'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
    'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
    'Netlify-Vary': 'query',
  };
}

/**
 * 获取视频详情。
 *
 * - 默认：返回完整详情（含剧集列表）。
 * - `fields=desc`：仅返回剧情简介。
 *   - `provider=vod`（默认）：简介来自搜索结果的 `vod_content`
 *     （见 mapItemToResult），先按标题搜索匹配 source+id，失败后再回退详情接口。
 *   - `provider=douban`：返回豆瓣条目简介。
 *   - `provider=bangumi`：返回 Bangumi 条目简介。
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const sourceCode = searchParams.get('source');
  const fields = searchParams.get('fields');
  const title = (searchParams.get('title') || '').trim();
  const provider = searchParams.get('provider') || 'vod';
  const descOnly = fields === 'desc';

  if (descOnly && provider === 'douban') {
    if (!id || !/^\d+$/.test(id)) {
      return NextResponse.json({ error: '无效的豆瓣ID' }, { status: 400 });
    }
    try {
      const doubanData = await fetchDoubanData<{ intro?: string }>(
        `https://m.douban.com/rexxar/api/v2/subject/${id}`
      );
      const cacheTime = await getCacheTime();
      return NextResponse.json(
        { desc: doubanData?.intro || '' },
        { headers: buildCacheHeaders(cacheTime) }
      );
    } catch {
      // 返回 502 让客户端下次重试，避免把暂态失败缓存成空简介
      return NextResponse.json({ error: '获取豆瓣简介失败' }, { status: 502 });
    }
  }

  if (descOnly && provider === 'bangumi') {
    if (!id || !/^\d+$/.test(id)) {
      return NextResponse.json({ error: '无效的 Bangumi ID' }, { status: 400 });
    }
    try {
      const bangumiData = await fetchBangumiSubjectDetail(id);
      const cacheTime = await getCacheTime();
      return NextResponse.json(
        { desc: bangumiData.summary },
        { headers: buildCacheHeaders(cacheTime) }
      );
    } catch {
      // 返回 502 让客户端下次重试，避免把暂态失败缓存成空简介
      return NextResponse.json(
        { error: '获取 Bangumi 简介失败' },
        {
          status: 502,
        }
      );
    }
  }

  if (!id || !sourceCode) {
    return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
  }

  if (!/^[\w-]+$/.test(id)) {
    return NextResponse.json({ error: '无效的视频ID格式' }, { status: 400 });
  }

  // 非本地存储模式下，所有详情路径都必须带上已由 middleware 验签的用户名。
  // getAvailableApiSites(undefined) 会返回全量未禁用源，之前只有 fields=desc
  // 分支取用户名，完整详情请求会因此绕过用户组的源权限。
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  const shareableCache = storageType === 'localstorage';
  let username: string | undefined;
  if (!shareableCache) {
    const auth = getAuthInfoFromCookie(request);
    if (!auth || !auth.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    username = auth.username;
  }

  try {
    const apiSites = await getAvailableApiSites(username);
    const apiSite = apiSites.find((site) => site.key === sourceCode);

    if (!apiSite) {
      return NextResponse.json({ error: '无效的API来源' }, { status: 400 });
    }

    const cacheTime = await getCacheTime();

    if (descOnly) {
      let desc = '';
      let searchMatched = false;

      if (title) {
        try {
          for await (const batch of searchFromApiStream(
            apiSite,
            title,
            true,
            12000
          )) {
            const match = batch.find((item) => String(item.id) === String(id));
            if (match) {
              searchMatched = true;
              if (match.desc) {
                desc = match.desc;
                break;
              }
            }
          }
        } catch {
          // 搜索失败时继续回退详情接口
        }
      }

      if (!desc) {
        try {
          const detail = await getDetailFromApi(apiSite, id);
          desc = detail.desc || '';
        } catch {
          // 搜索未命中且详情也失败时返回 502，让客户端下次重试
          if (!searchMatched) {
            return NextResponse.json(
              { error: '获取简介失败' },
              { status: 502 }
            );
          }
        }
      }

      return NextResponse.json(
        { desc },
        { headers: buildCacheHeaders(cacheTime, shareableCache) }
      );
    }

    const result = await getDetailFromApi(apiSite, id);
    return NextResponse.json(result, {
      headers: buildCacheHeaders(cacheTime, shareableCache),
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
