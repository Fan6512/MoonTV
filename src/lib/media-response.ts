/**
 * 媒体代理的响应约束（纯逻辑，可在 Edge runtime 使用）。
 *
 * `/api/image-proxy` 与 `/api/m3u8` 被 middleware 排除在登录保护之外，
 * 是整站最容易被用来打带宽 / 打 Edge Function 资源的入口。这里提供四类约束：
 *  1. 只放行位图 content-type，默认拒绝 SVG（同源代理下 SVG 可携带脚本）；
 *  2. Content-Length 预检，声明超限立即拒绝，不必拉流；
 *  3. 无 Content-Length 时按字节流式计数，超限立即中断上游；
 *  4. 把「客户端取消」与「总耗时上限」合并为一个 signal。
 *
 * 并发配额属于平台层能力（Vercel WAF / Rate Limit），不在代码里伪造全局计数器。
 */

/** 单张海报的合理上限，8MB 远大于常见封面 */
export const MAX_PROXIED_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_PROXY_TIMEOUT_MS = 15_000;
export const VIDEO_PROXY_TIMEOUT_MS = 30_000;

/**
 * 只允许位图。`image/svg+xml` 及其它 `image/*+xml` 一律拒绝：
 * SVG 作为独立文档打开时可以内嵌脚本，经同源代理后会带上站点源的权限，
 * 即使响应带 `X-Content-Type-Options: nosniff` 也不该默认放行。
 */
export function isAllowedImageContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase().split(';')[0].trim();
  if (!normalized.startsWith('image/')) return false;
  return !normalized.endsWith('+xml');
}

/** 声明的响应体已超限则返回 true；缺失或非法 Content-Length 交给流式计数兜底 */
export function exceedsMaxBytes(
  contentLength: string | null,
  maxBytes = MAX_PROXIED_IMAGE_BYTES
): boolean {
  if (!contentLength) return false;
  const declared = Number(contentLength);
  return Number.isFinite(declared) && declared > maxBytes;
}

/**
 * 合并客户端取消信号与总耗时上限。
 *
 * 不使用 `AbortSignal.any` / `AbortSignal.timeout`，避免依赖较新的运行时实现。
 * 返回的 signal 覆盖整个请求（含响应体流），因此慢速无界流也会被切断；
 * 需要长时间流式传输的调用方可以在拿到响应头后调用 releaseTimeout()。
 */
export interface ProxySignal {
  signal: AbortSignal;
  /**
   * 响应头已到达、进入流式阶段时调用：只取消超时计时，仍保留客户端取消的传播。
   * 视频片段下载可能持续较久，不适合给整个响应体套固定总时长。
   */
  releaseTimeout: () => void;
}

export function createProxySignal(
  clientSignal: AbortSignal | undefined,
  timeoutMs: number
): ProxySignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (clientSignal?.aborted) {
    abort();
  } else {
    clientSignal?.addEventListener('abort', abort, { once: true });
  }

  if (!controller.signal.aborted) {
    timer = setTimeout(abort, timeoutMs);
  }

  return {
    signal: controller.signal,
    releaseTimeout: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** 流式字节计数：超过上限就 cancel 上游并让下游流报错 */
export function createSizeLimitedStream(
  body: ReadableStream<Uint8Array>,
  maxBytes = MAX_PROXIED_IMAGE_BYTES
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let received = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        received += value.byteLength;
        if (received > maxBytes) {
          void reader.cancel();
          controller.error(new Error('proxied image exceeds size limit'));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
}
