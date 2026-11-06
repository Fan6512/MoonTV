/** @jest-environment node */

import { ReadableStream as NodeReadableStream } from 'node:stream/web';

import {
  IMAGE_PROXY_TIMEOUT_MS,
  MAX_PROXIED_IMAGE_BYTES,
} from '@/lib/media-response';
import { fetchMediaUrl, validateMediaUrl } from '@/lib/url-guard';

import { GET } from '../route';

/**
 * `/api/image-proxy` 安全与流式边界接线测试（Batch 0 + PR #2 复审补充）。
 *
 * jest 环境不注入 Web 全局，这里用 node:stream/web 的 ReadableStream
 * 以及极简 Headers / Response 替身承接路由返回值。
 *
 * 覆盖复审要求的四类场景：慢速流超时、无 Content-Length 的超限流、
 * 客户端断开、以及成功/失败响应的 CDN 缓存头。
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
    json: jest.fn(
      (
        body: unknown,
        init?: { status?: number; headers?: Record<string, string> }
      ) => ({
        status: init?.status ?? 200,
        body,
        headers: init?.headers ?? {},
      })
    ),
  },
}));

jest.mock('@/lib/url-guard', () => ({
  validateMediaUrl: jest.fn(),
  fetchMediaUrl: jest.fn(),
}));

interface JsonResponse {
  status: number;
  body: { error: string };
  headers: Record<string, string>;
}

function makeRequest(query: string, signal?: AbortSignal) {
  return {
    url: `https://example.com/api/image-proxy${query}`,
    signal,
  } as unknown as Request;
}

const IMG_QUERY = '?url=https%3A%2F%2Fimg.example.com%2Fa.png';

interface UpstreamOptions {
  contentType?: string | null;
  contentLength?: string | null;
  ok?: boolean;
  status?: number;
  statusText?: string;
  chunks?: Uint8Array[];
  signal?: AbortSignal;
  /** 只挂起不产出字节，直到 signal 被 abort（模拟慢速无界流） */
  stall?: boolean;
}

function makeUpstream({
  contentType = 'image/png',
  contentLength = '4',
  ok = true,
  status = 200,
  statusText = 'OK',
  chunks = [new Uint8Array(4)],
  signal,
  stall = false,
}: UpstreamOptions = {}) {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stall) {
        signal?.addEventListener(
          'abort',
          () => controller.error(new Error('aborted')),
          { once: true }
        );
        return;
      }
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    ok,
    status,
    statusText,
    headers: {
      get: (key: string) => {
        if (key === 'content-type') return contentType;
        if (key === 'content-length') return contentLength;
        return null;
      },
    },
    body,
    get canceled() {
      return canceled;
    },
  };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function expectNoStore(res: JsonResponse) {
  expect(res.headers['Cache-Control']).toBe('no-store');
  expect(res.headers['CDN-Cache-Control']).toBe('no-store');
  expect(res.headers['Vercel-CDN-Cache-Control']).toBe('no-store');
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  (validateMediaUrl as jest.Mock).mockReturnValue({ ok: true });
  (fetchMediaUrl as jest.Mock).mockResolvedValue(makeUpstream());
});

afterEach(() => {
  jest.useRealTimers();
});

describe('参数、SSRF 与白名单隔离', () => {
  it('缺少 url 参数返回 400 且错误响应 no-store', async () => {
    const res = (await GET(makeRequest(''))) as unknown as JsonResponse;

    expect(res.status).toBe(400);
    expectNoStore(res);
    expect(fetchMediaUrl).not.toHaveBeenCalled();
  });

  it('URL 校验不通过返回 403，且使用图片白名单 scope', async () => {
    (validateMediaUrl as jest.Mock).mockReturnValue({
      ok: false,
      reason: '不允许访问该地址',
    });

    const res = (await GET(
      makeRequest('?url=http%3A%2F%2F127.0.0.1%2Fa.jpg')
    )) as unknown as JsonResponse;

    expect(res.status).toBe(403);
    expectNoStore(res);
    expect(validateMediaUrl).toHaveBeenCalledWith(
      'http://127.0.0.1/a.jpg',
      undefined,
      'image'
    );
    expect(fetchMediaUrl).not.toHaveBeenCalled();
  });

  it('回源请求也带 image scope，重定向逐跳校验由 url-guard 负责', async () => {
    await GET(makeRequest(IMG_QUERY));

    const call = (fetchMediaUrl as jest.Mock).mock.calls[0];
    expect(call[2]).toBe('image');
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('上游返回非 2xx 时透传状态并取消响应体', async () => {
    const upstream = makeUpstream({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });
    (fetchMediaUrl as jest.Mock).mockResolvedValue(upstream);

    const res = (await GET(makeRequest(IMG_QUERY))) as unknown as JsonResponse;

    expect(res.status).toBe(404);
    expectNoStore(res);
    expect(upstream.canceled).toBe(true);
  });
});

describe('响应类型与体积约束', () => {
  it('默认拒绝 image/svg+xml，并取消上游响应体', async () => {
    const upstream = makeUpstream({ contentType: 'image/svg+xml' });
    (fetchMediaUrl as jest.Mock).mockResolvedValue(upstream);

    const res = (await GET(makeRequest(IMG_QUERY))) as unknown as JsonResponse;

    expect(res.status).toBe(415);
    expect(res.body.error).toContain('Not an allowed image response');
    expectNoStore(res);
    expect(upstream.canceled).toBe(true);
  });

  it('拒绝非图片 content-type', async () => {
    (fetchMediaUrl as jest.Mock).mockResolvedValue(
      makeUpstream({ contentType: 'text/html' })
    );

    const res = (await GET(makeRequest(IMG_QUERY))) as unknown as JsonResponse;
    expect(res.status).toBe(415);
  });

  it('白名单外的 image/* 子类型同样拒绝', async () => {
    const upstream = makeUpstream({ contentType: 'image/tiff' });
    (fetchMediaUrl as jest.Mock).mockResolvedValue(upstream);

    const res = (await GET(makeRequest(IMG_QUERY))) as unknown as JsonResponse;

    expect(res.status).toBe(415);
    expect(upstream.canceled).toBe(true);
  });

  it('Content-Length 声明超限时返回 413，不拉取响应体', async () => {
    const upstream = makeUpstream({
      contentLength: String(MAX_PROXIED_IMAGE_BYTES + 1),
    });
    (fetchMediaUrl as jest.Mock).mockResolvedValue(upstream);

    const res = (await GET(makeRequest(IMG_QUERY))) as unknown as JsonResponse;

    expect(res.status).toBe(413);
    expectNoStore(res);
    expect(upstream.canceled).toBe(true);
  });

  it('无 Content-Length 且实际超限：在发出 200 之前就返回 413', async () => {
    (fetchMediaUrl as jest.Mock).mockResolvedValue(
      makeUpstream({
        contentLength: null,
        chunks: [new Uint8Array(MAX_PROXIED_IMAGE_BYTES + 1)],
      })
    );

    const res = (await GET(makeRequest(IMG_QUERY))) as unknown as JsonResponse;

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('Image too large');
    expectNoStore(res);
  });

  it('无 Content-Length 但分块累计超限同样返回 413', async () => {
    const half = MAX_PROXIED_IMAGE_BYTES / 2 + 1;
    (fetchMediaUrl as jest.Mock).mockResolvedValue(
      makeUpstream({
        contentLength: null,
        chunks: [new Uint8Array(half), new Uint8Array(half)],
      })
    );

    const res = (await GET(makeRequest(IMG_QUERY))) as unknown as JsonResponse;
    expect(res.status).toBe(413);
  });
});

describe('慢速流、客户端断开与 CDN 缓存边界', () => {
  it('慢速流触发 15s 超时后返回 504（img onError 可回退占位图）', async () => {
    (fetchMediaUrl as jest.Mock).mockImplementation(async (_url, options) =>
      makeUpstream({ signal: options.signal, stall: true })
    );

    const pending = GET(makeRequest(IMG_QUERY));
    await flush();
    jest.advanceTimersByTime(IMAGE_PROXY_TIMEOUT_MS);
    await flush();
    const res = (await pending) as unknown as JsonResponse;

    expect(res.status).toBe(504);
    expect(res.body.error).toBe('Upstream image timed out');
    expectNoStore(res);
  });

  it('客户端断开返回 499，不留可被共享缓存的响应', async () => {
    const controller = new AbortController();
    (fetchMediaUrl as jest.Mock).mockImplementation(async (_url, options) =>
      makeUpstream({ signal: options.signal, stall: true })
    );

    const pending = GET(makeRequest(IMG_QUERY, controller.signal));
    await flush();
    controller.abort();
    await flush();
    const res = (await pending) as unknown as JsonResponse;

    expect(res.status).toBe(499);
    expectNoStore(res);
  });

  it('成功响应是完整字节、带准确 Content-Length 才可长期共享缓存', async () => {
    (fetchMediaUrl as jest.Mock).mockResolvedValue(
      makeUpstream({
        contentLength: null,
        chunks: [new Uint8Array(3), new Uint8Array(4)],
      })
    );

    const res = (await GET(makeRequest(IMG_QUERY))) as unknown as FakeResponse;

    expect(res).toBeInstanceOf(FakeResponse);
    expect(res.init.status).toBe(200);
    expect(res.init.headers.get('Content-Type')).toBe('image/png');
    expect(res.init.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.init.headers.get('Content-Length')).toBe('7');
    expect((res.body as Uint8Array).byteLength).toBe(
      Number(res.init.headers.get('Content-Length'))
    );
    expect(res.init.headers.get('Cache-Control')).toContain('s-maxage');
    expect(res.init.headers.get('CDN-Cache-Control')).toContain('s-maxage');
  });

  it('上游响应没有 body 时返回 500 且 no-store', async () => {
    const upstream = makeUpstream();
    Object.defineProperty(upstream, 'body', { value: null });
    (fetchMediaUrl as jest.Mock).mockResolvedValue(upstream);

    const res = (await GET(makeRequest(IMG_QUERY))) as unknown as JsonResponse;
    expect(res.status).toBe(500);
    expectNoStore(res);
  });
});
