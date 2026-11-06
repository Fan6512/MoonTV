/**
 * `/api/detail` 用户组源权限回归测试（Batch 0）。
 *
 * 背景：修复前 `username` 只在 `fields=desc` 分支赋值，完整详情请求把
 * `undefined` 传给 `getAvailableApiSites()` → 返回全量未禁用源 → 受限用户
 * 可以直接构造请求访问组内被禁止的源。同时响应带 `public, s-maxage`，
 * 按用户组过滤的结果还可能被 CDN 跨用户共享。
 *
 * 这里用轻量 fake request / fake NextResponse，避免 jsdom 缺少 Web
 * Request 全局导致测试无法运行；断言聚焦于「身份是否贯穿」与「缓存是否隔离」。
 */

import { NextRequest } from 'next/server';

import { getAvailableApiSites } from '@/lib/config';

import { GET } from '../route';

jest.mock('next/server', () => ({
  NextRequest: class {},
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
  getAvailableApiSites: jest.fn(),
  getCacheTime: jest.fn(async () => 7200),
}));

jest.mock('@/lib/downstream', () => ({
  getDetailFromApi: jest.fn(async () => ({ title: '示例影片', episodes: [] })),
  searchFromApiStream: jest.fn(),
}));

jest.mock('@/lib/douban', () => ({
  fetchDoubanData: jest.fn(async () => ({ intro: '示例简介' })),
}));

jest.mock('@/lib/bangumi', () => ({
  fetchBangumiSubjectDetail: jest.fn(async () => ({ summary: '示例简介' })),
}));

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const ALL_SITES = [
  { key: 'free', name: '免费源', api: 'https://free.example.com' },
  { key: 'premium', name: '付费源', api: 'https://premium.example.com' },
];

/** 复刻 config.ts 的关键行为：没有用户名时返回全量未禁用源 */
const GROUP_SOURCES: Record<string, typeof ALL_SITES> = {
  // 基础组：只能看免费源
  alice: [ALL_SITES[0]],
  // 高级组：全部源
  bob: ALL_SITES,
};

function makeRequest(
  query: string,
  username?: string,
  signature = 'valid-signature'
): NextRequest {
  return {
    url: `https://example.com/api/detail${query}`,
    cookies: {
      get: (name: string) =>
        name === 'auth' && username
          ? {
              name,
              value: encodeURIComponent(
                JSON.stringify({ username, signature })
              ),
            }
          : undefined,
    },
  } as unknown as NextRequest;
}

const originalStorageType = process.env.NEXT_PUBLIC_STORAGE_TYPE;

beforeEach(() => {
  jest.clearAllMocks();
  (getAvailableApiSites as jest.Mock).mockImplementation(
    async (username?: string) =>
      username ? GROUP_SOURCES[username] ?? [] : ALL_SITES
  );
});

afterAll(() => {
  if (originalStorageType === undefined) {
    delete process.env.NEXT_PUBLIC_STORAGE_TYPE;
  } else {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = originalStorageType;
  }
});

describe('本地存储模式（无用户组概念）', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = 'localstorage';
  });

  it('无登录也能取详情，且响应仍可走共享缓存', async () => {
    const res = (await GET(
      makeRequest('?source=free&id=1')
    )) as unknown as FakeResponse;

    expect(res.status).toBe(200);
    expect(getAvailableApiSites).toHaveBeenCalledWith(undefined);
    expect(res.headers['Cache-Control']).toContain('s-maxage');
    expect(res.headers['Vary']).toBeUndefined();
  });
});

describe('非本地存储模式（启用用户组源权限）', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = 'd1';
  });

  it('未登录时直接 401，不接触源列表', async () => {
    const res = (await GET(
      makeRequest('?source=free&id=1')
    )) as unknown as FakeResponse;

    expect(res.status).toBe(401);
    expect(getAvailableApiSites).not.toHaveBeenCalled();
  });

  it('完整详情请求必须把用户名传给源过滤，禁止源返回 400', async () => {
    const res = (await GET(
      makeRequest('?source=premium&id=1', 'alice')
    )) as unknown as FakeResponse;

    expect(getAvailableApiSites).toHaveBeenCalledWith('alice');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: '无效的API来源' });
  });

  it('允许源返回 200，且响应禁止进入共享缓存', async () => {
    const res = (await GET(
      makeRequest('?source=free&id=1', 'alice')
    )) as unknown as FakeResponse;

    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, max-age=7200');
    expect(res.headers['Cache-Control']).not.toContain('s-maxage');
    expect(res.headers['Vary']).toBe('Cookie');
    expect(res.headers['CDN-Cache-Control']).toBe('private, no-store');
    expect(res.headers['Vercel-CDN-Cache-Control']).toBe('private, no-store');
  });

  it('不同用户组得到不同的源访问结果', async () => {
    const alice = (await GET(
      makeRequest('?source=premium&id=1', 'alice')
    )) as unknown as FakeResponse;
    const bob = (await GET(
      makeRequest('?source=premium&id=1', 'bob')
    )) as unknown as FakeResponse;

    expect(alice.status).toBe(400);
    expect(bob.status).toBe(200);
    expect(getAvailableApiSites).toHaveBeenCalledWith('alice');
    expect(getAvailableApiSites).toHaveBeenCalledWith('bob');
  });

  it('fields=desc 分支同样按用户组过滤，并使用私有缓存', async () => {
    const blocked = (await GET(
      makeRequest('?fields=desc&source=premium&id=1', 'alice')
    )) as unknown as FakeResponse;
    const allowed = (await GET(
      makeRequest('?fields=desc&source=free&id=1', 'alice')
    )) as unknown as FakeResponse;

    expect(blocked.status).toBe(400);
    expect(allowed.status).toBe(200);
    expect(allowed.headers['Cache-Control']).toBe('private, max-age=7200');
  });

  it('公开的豆瓣简介分支不依赖源权限，保留共享缓存', async () => {
    const res = (await GET(
      makeRequest('?fields=desc&provider=douban&id=1292052')
    )) as unknown as FakeResponse;

    expect(res.status).toBe(200);
    expect(getAvailableApiSites).not.toHaveBeenCalled();
    expect(res.headers['Cache-Control']).toContain('s-maxage');
  });
});
