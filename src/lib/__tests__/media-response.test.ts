/** @jest-environment node */

import { ReadableStream as NodeReadableStream } from 'node:stream/web';

import {
  createProxySignal,
  createSizeLimitedStream,
  exceedsMaxBytes,
  IMAGE_PROXY_TIMEOUT_MS,
  isAllowedImageContentType,
  MAX_PROXIED_IMAGE_BYTES,
} from '../media-response';

// jest 的 vm 环境不会注入 Node 22 的 Web Streams 全局，显式挂上内置实现。
// 测试代码统一使用 DOM 的 ReadableStream 类型，避免与 stream/web 的定义冲突。
Object.assign(globalThis, { ReadableStream: NodeReadableStream });

function chunksToStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.byteLength;
  }
}

describe('isAllowedImageContentType', () => {
  it('放行常见位图格式', () => {
    [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/avif',
      'image/gif',
    ].forEach((type) => expect(isAllowedImageContentType(type)).toBe(true));
  });

  it('默认拒绝 SVG（含大小写与 charset 变体）', () => {
    [
      'image/svg+xml',
      'image/svg+xml; charset=utf-8',
      'IMAGE/SVG+XML',
      'image/vnd.adobe.photoshop+xml',
    ].forEach((type) => expect(isAllowedImageContentType(type)).toBe(false));
  });

  it('拒绝非图片与缺失的 content-type', () => {
    expect(isAllowedImageContentType('text/html')).toBe(false);
    expect(isAllowedImageContentType('application/xml')).toBe(false);
    expect(isAllowedImageContentType(null)).toBe(false);
  });
});

describe('exceedsMaxBytes', () => {
  it('缺失或非法 Content-Length 交给流式计数兜底', () => {
    expect(exceedsMaxBytes(null)).toBe(false);
    expect(exceedsMaxBytes('')).toBe(false);
    expect(exceedsMaxBytes('not-a-number')).toBe(false);
  });

  it('声明值超过上限才拒绝，等于上限仍放行', () => {
    expect(exceedsMaxBytes(String(MAX_PROXIED_IMAGE_BYTES))).toBe(false);
    expect(exceedsMaxBytes(String(MAX_PROXIED_IMAGE_BYTES + 1))).toBe(true);
  });

  it('上限可自定义', () => {
    expect(exceedsMaxBytes('11', 10)).toBe(true);
    expect(exceedsMaxBytes('10', 10)).toBe(false);
  });
});

describe('createSizeLimitedStream', () => {
  it('未超限时完整转发所有字节', async () => {
    const stream = createSizeLimitedStream(
      chunksToStream([new Uint8Array(4), new Uint8Array(6), new Uint8Array(2)]),
      100
    );
    await expect(collect(stream)).resolves.toBe(12);
  });

  it('累计超限后切断上游并让下游流报错', async () => {
    const stream = createSizeLimitedStream(
      chunksToStream([new Uint8Array(6), new Uint8Array(6)]),
      10
    );
    await expect(collect(stream)).rejects.toThrow(
      'proxied image exceeds size limit'
    );
  });
});

describe('createProxySignal', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('客户端已经取消时立刻返回 aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const proxy = createProxySignal(controller.signal, 1000);

    expect(proxy.signal.aborted).toBe(true);
    proxy.releaseTimeout();
  });

  it('客户端中途取消会传播', () => {
    const controller = new AbortController();
    const proxy = createProxySignal(controller.signal, 1000);

    expect(proxy.signal.aborted).toBe(false);
    controller.abort();
    expect(proxy.signal.aborted).toBe(true);
    proxy.releaseTimeout();
  });

  it('等待响应头超过上限会自动取消', () => {
    jest.useFakeTimers();
    const proxy = createProxySignal(undefined, IMAGE_PROXY_TIMEOUT_MS);

    expect(proxy.signal.aborted).toBe(false);
    jest.advanceTimersByTime(IMAGE_PROXY_TIMEOUT_MS);
    expect(proxy.signal.aborted).toBe(true);
    proxy.releaseTimeout();
  });

  it('releaseTimeout 后不再因超时取消，但客户端取消仍有效', () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const proxy = createProxySignal(controller.signal, 1000);
    proxy.releaseTimeout();

    jest.advanceTimersByTime(2000);
    expect(proxy.signal.aborted).toBe(false);

    controller.abort();
    expect(proxy.signal.aborted).toBe(true);
  });
});
