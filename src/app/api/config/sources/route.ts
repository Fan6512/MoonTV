/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites, getCacheTime } from '@/lib/config';

// 本路由按用户 cookie 过滤源，结果因人而异，必须在请求期渲染。
// 不声明时 Next 会在 build 阶段尝试静态预渲染，触发 DYNAMIC_SERVER_USAGE，
// 该框架信号会被下方 catch 吞掉并误报为「获取视频源失败」。
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const auth = getAuthInfoFromCookie(request);
    const username = auth?.username;
    const sites = await getAvailableApiSites(username);
    const cacheTime = await getCacheTime();
    return NextResponse.json(sites, {
      headers: {
        'Cache-Control': `public, max-age=${cacheTime}, s-maxage=0`,
      },
    });
  } catch (error) {
    console.error('获取按用户过滤的视频源失败:', error);
    return NextResponse.json(
      { error: '获取视频源失败' },
      { status: 500 }
    );
  }
}