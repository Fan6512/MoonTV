/** @jest-environment node */

import { getCacheTime } from '@/lib/config';
import { fetchDoubanData } from '@/lib/douban';

import { GET } from '../route';

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn(
      (
        body: unknown,
        init?: { status?: number; headers?: Record<string, string> }
      ) => ({
        status: init?.status ?? 200,
        headers: init?.headers ?? {},
        body,
      })
    ),
  },
}));

jest.mock('@/lib/config', () => ({
  getCacheTime: jest.fn(),
}));

jest.mock('@/lib/douban', () => ({
  fetchDoubanData: jest.fn(),
}));

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function makeRequest(extraParams = ''): Request {
  const params = new URLSearchParams({
    kind: 'movie',
    category: '热门',
    type: '全部',
    limit: '20',
    start: '0',
  });

  if (extraParams) {
    const extra = new URLSearchParams(extraParams);
    extra.forEach((value, key) => params.set(key, value));
  }

  return {
    url: `https://example.com/api/douban/categories?${params.toString()}`,
  } as Request;
}

const UPSTREAM_PAYLOAD = {
  total: 1,
  items: [
    {
      id: '1292052',
      title: '示例影片',
      card_subtitle: '2026 年',
      pic: {
        large: 'https://img.example.com/large.jpg',
        normal: 'https://img.example.com/normal.jpg',
      },
      rating: { value: 8.6 },
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  (getCacheTime as jest.Mock).mockResolvedValue(7200);
  (fetchDoubanData as jest.Mock).mockResolvedValue(UPSTREAM_PAYLOAD);
});

describe('/api/douban/categories upstream cache', () => {
  it('uses the configured TTL for the upstream Data Cache and keeps CDN cache headers', async () => {
    const res = (await GET(
      makeRequest('__probe=unique-outer-cache-key')
    )) as unknown as FakeResponse;

    expect(res.status).toBe(200);
    expect(fetchDoubanData).toHaveBeenCalledWith(
      'https://m.douban.com/rexxar/api/v2/subject/recent_hot/movie?start=0&limit=20&category=热门&type=全部',
      { revalidate: 7200 }
    );
    expect(getCacheTime).toHaveBeenCalledTimes(1);
    expect(res.headers['Cache-Control']).toBe(
      'public, max-age=7200, s-maxage=7200'
    );
    expect(res.headers['CDN-Cache-Control']).toBe('public, s-maxage=7200');
    expect(res.headers['Vercel-CDN-Cache-Control']).toBe(
      'public, s-maxage=7200'
    );
    expect(res.headers['Server-Timing']).toMatch(/config;dur=/);
    expect(res.headers['Server-Timing']).toMatch(/douban;dur=/);
    expect(res.headers['Server-Timing']).toMatch(/transform;dur=/);
    expect(res.headers['Server-Timing']).toMatch(/total;dur=/);
    expect(res.body).toEqual({
      code: 200,
      message: '获取成功',
      list: [
        {
          id: '1292052',
          title: '示例影片',
          poster: 'https://img.example.com/normal.jpg',
          rate: '8.6',
          year: '2026',
        },
      ],
    });
  });

  it('keeps upstream failures uncached and still reports phase timing', async () => {
    (fetchDoubanData as jest.Mock).mockRejectedValue(
      new Error('The operation was aborted')
    );

    const res = (await GET(makeRequest())) as unknown as FakeResponse;

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: '获取豆瓣数据失败',
      details: 'The operation was aborted',
    });
    expect(res.headers['Server-Timing']).toMatch(/config;dur=/);
    expect(res.headers['Server-Timing']).toMatch(/douban;dur=/);
    expect(res.headers['Cache-Control']).toBeUndefined();
  });
});
