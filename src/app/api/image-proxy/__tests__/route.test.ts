/** @jest-environment node */

import { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { fetchMediaUrl, validateMediaUrl } from '@/lib/url-guard';

import { GET } from '../route';

/**
 * `/api/image-proxy` 安全约束接线测试（Batch 0）。
 *
 * jsdom / jest 的 node 环境都不注入 Web 全局，这里用 node:stream/web 提供
 * ReadableStream，并用极简的 Headers / Response 替身承接路由返回值。
 */

class FakeHeaders {
  private readonly store = new Map<string, string>();

  set(key: string, value: string) {
    this.store.set(key.toLowerCase(), value);
  }

  get(key: string): string | null {
    return this.store.get(key.toLowerCase()) ?? null;
  }
}

class FakeResponse {
  constructor(
    public readonly body: unknown,
    public readonly init: { status: number; headers: FakeHeaders }
  ) {}
}

Object.assign(globalThis, {
  ReadableStream: NodeReadableStream,
  Headers: FakeHeaders,
  Response: FakeResponse,
});

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      body,
    })),
  },
}));

jest.mock('@/lib/url-guard', () => ({
  validateMediaUrl: jest.fn(),
  fetchMediaUrl: jest.fn(),
}));

interface FakeJsonResponse {
  status: number;
  body: { error: string };
}

function makeRequest(query: string) {
  return {
    url: `https://example.com/api/image-proxy${query}`,
    signal: undefined,
  } as unknown as Request;
}

function makeUpstream({
  contentType = 'image/png',
  contentLength = '4',
  ok = true,
  status = 200,
}: {
  contentType?: string | null;
  contentLength?: string | null;
  ok?: boolean;
  status?: number;
} = {}) {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4));
      controller.close();
    },
  });
  return {
    ok,
    status,
    statusText: 'OK',
    headers: {
      get: (key: string) => {
        if (key === 'content-type') return contentType;
        if (key === 'content-length') return contentLength;
        return null;
      },
    },
    body: {
      getReader: () => body.getReader(),
      cancel: async () => {
        canceled = true;
      },
    },
    get canceled() {
      return canceled;
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  (validateMediaUrl as jest.Mock).mockReturnValue({ ok: true });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('参数与 SSRF 防护', () => {
  it('缺少 url 参数返回 400', async () => {
    const res = (await GET(makeRequest(''))) as unknown as FakeJsonResponse;

    expect(res.status).toBe(400);
    expect(fetchMediaUrl).not.toHaveBeenCalled();
  });

  it('URL 校验不通过返回 403', async () => {
    (validateMediaUrl as jest.Mock).mockReturnValue({
      ok: false,
      reason: '不允许访问该地址',
    });

    const res = (await GET(
      makeRequest('?url=http%3A%2F%2F127.0.0.1%2Fa.jpg')
    )) as unknown as FakeJsonResponse;

    expect(res.status).toBe(403);
    expect(fetchMediaUrl).not.toHaveBeenCalled();
  });
});

describe('响应类型与体积约束', () => {
  it('默认拒绝 image/svg+xml，并取消上游响应体', async () => {
    const upstream = makeUpstream({ contentType: 'image/svg+xml' });
    (fetchMediaUrl as jest.Mock).mockResolvedValue(upstream);

    const res = (await GET(
      makeRequest('?url=https%3A%2F%2Fimg.example.com%2Fa.svg')
    )) as unknown as FakeJsonResponse;

    expect(res.status).toBe(415);
    expect(res.body.error).toContain('Not an allowed image response');
    expect(upstream.canceled).toBe(true);
  });

  it('拒绝非图片 content-type', async () => {
    (fetchMediaUrl as jest.Mock).mockResolvedValue(
      makeUpstream({ contentType: 'text/html' })
    );

    const res = (await GET(
      makeRequest('?url=https%3A%2F%2Fimg.example.com%2Fa')
    )) as unknown as FakeJsonResponse;

    expect(res.status).toBe(415);
  });

  it('Content-Length 声明超限时返回 413，不拉取响应体', async () => {
    const upstream = makeUpstream({ contentLength: String(9 * 1024 * 1024) });
    (fetchMediaUrl as jest.Mock).mockResolvedValue(upstream);

    const res = (await GET(
      makeRequest('?url=https%3A%2F%2Fimg.example.com%2Fbig.png')
    )) as unknown as FakeJsonResponse;

    expect(res.status).toBe(413);
    expect(upstream.canceled).toBe(true);
  });

  it('正常位图返回 200，带 nosniff 且使用受限流', async () => {
    (fetchMediaUrl as jest.Mock).mockResolvedValue(makeUpstream());

    const res = (await GET(
      makeRequest('?url=https%3A%2F%2Fimg.example.com%2Fa.png')
    )) as unknown as FakeResponse;

    expect(res).toBeInstanceOf(FakeResponse);
    expect(res.init.status).toBe(200);
    expect(res.init.headers.get('Content-Type')).toBe('image/png');
    expect(res.init.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.body).toBeDefined();
  });

  it('把客户端取消与超时合并后的 signal 传给上游', async () => {
    (fetchMediaUrl as jest.Mock).mockResolvedValue(makeUpstream());

    await GET(makeRequest('?url=https%3A%2F%2Fimg.example.com%2Fa.png'));

    const options = (fetchMediaUrl as jest.Mock).mock.calls[0][1] as {
      signal: AbortSignal;
    };
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
  });
});
