/** @jest-environment node */

import { ReadableStream as NodeReadableStream } from 'node:stream/web';

import {
  createProxySignal,
  exceedsMaxBytes,
  IMAGE_PROXY_TIMEOUT_MS,
  isAllowedImageContentType,
  MAX_PROXIED_IMAGE_BYTES,
  readBoundedBody,
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

describe('isAllowedImageContentType', () => {
  it('放行常见位图格式', () => {
    [
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
      'image/avif',
      'image/gif',
      'image/apng',
      'image/bmp',
      'image/x-icon',
      'image/vnd.microsoft.icon',
    ].forEach((type) => expect(isAllowedImageContentType(type)).toBe(true));
  });

  it('忽略大小写与 charset 参数', () => {
    expect(isAllowedImageContentType('IMAGE/PNG')).toBe(true);
    expect(isAllowedImageContentType('image/webp; charset=binary')).toBe(true);
    expect(isAllowedImageContentType('image/jpeg;charset=UTF-8')).toBe(true);
  });

  it('默认拒绝 SVG（含大小写与 charset 变体）', () => {
    [
      'image/svg+xml',
      'image/svg+xml; charset=utf-8',
      'IMAGE/SVG+XML',
      'image/vnd.adobe.photoshop+xml',
    ].forEach((type) => expect(isAllowedImageContentType(type)).toBe(false));
  });

  it('白名单外的 image/* 子类型不再默认放行', () => {
    // 旧实现是 startsWith('image/') + 排除 +xml，这些都会被放行
    ['image/tiff', 'image/x-custom-format', 'image/vnd.djvu'].forEach((type) =>
      expect(isAllowedImageContentType(type)).toBe(false)
    );
  });

  it('拒绝非图片与缺失的 content-type', () => {
    expect(isAllowedImageContentType('text/html')).toBe(false);
    expect(isAllowedImageContentType('application/octet-stream')).toBe(false);
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

describe('readBoundedBody', () => {
  it('未超限时合并所有 chunk，返回准确字节数', async () => {
    const result = await readBoundedBody(
      chunksToStream([new Uint8Array(4), new Uint8Array(6), new Uint8Array(2)]),
      100
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byteLength).toBe(12);
    expect(result.bytes.byteLength).toBe(12);
  });

  it('单个 chunk 直接复用，不额外分配内存', async () => {
    const chunk = new Uint8Array(7);
    const result = await readBoundedBody(chunksToStream([chunk]), 100);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).toBe(chunk);
  });

  it('字节数恰好等于上限时仍放行', async () => {
    const result = await readBoundedBody(
      chunksToStream([new Uint8Array(10)]),
      10
    );
    expect(result.ok).toBe(true);
  });

  it('无 Content-Length 且累计超限时取消上游并返回 too-large', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        // 故意不 close，模拟仍在传输的大图
      },
      cancel() {
        canceled = true;
      },
    });

    const result = await readBoundedBody(stream, 10);

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(canceled).toBe(true);
  });

  it('读取中途被 abort（超时 / 客户端断开）时取消上游并原样抛出', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('aborted'));
      },
    });

    await expect(readBoundedBody(stream)).rejects.toThrow('aborted');
  });

  it('默认上限为 8MB', () => {
    expect(MAX_PROXIED_IMAGE_BYTES).toBe(8 * 1024 * 1024);
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

  it('超时触发后 timedOut 为 true，客户端取消不会误判成超时', () => {
    jest.useFakeTimers();
    const timeout = createProxySignal(undefined, 1000);
    jest.advanceTimersByTime(1000);

    expect(timeout.timedOut).toBe(true);
    expect(timeout.signal.aborted).toBe(true);
    timeout.releaseTimeout();

    const controller = new AbortController();
    const client = createProxySignal(controller.signal, 1000);
    controller.abort();

    expect(client.timedOut).toBe(false);
    expect(client.signal.aborted).toBe(true);
    client.releaseTimeout();
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
