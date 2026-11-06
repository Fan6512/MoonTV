/**
 * 媒体代理的响应约束（纯逻辑，可在 Edge runtime 使用）。
 *
 * `/api/image-proxy` 与 `/api/m3u8` 被 middleware 排除在登录保护之外，
 * 是整站最容易被用来打带宽 / 打 Edge Function 资源的入口。这里提供四类约束：
 *  1. 只放行位图 content-type，默认拒绝 SVG（同源代理下 SVG 可携带脚本）；
 *  2. Content-Length 预检，声明超限立即拒绝，不必拉流；
 *  3. 无 Content-Length 时把响应体读到上限再一次性返回，超限可正确回 413，
 *     且不会让带 `public, s-maxage` 的不完整 200 响应被 CDN 缓存；
 *  4. 把「客户端取消」与「总耗时上限」合并为一个 signal，并区分超时与取消。
 *
 * 并发配额属于平台层能力（Vercel WAF / Rate Limit），不在代码里伪造全局计数器。
 */

/** 单张海报的合理上限，8MB 远大于常见封面 */
export const MAX_PROXIED_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_PROXY_TIMEOUT_MS = 15_000;
export const VIDEO_PROXY_TIMEOUT_MS = 30_000;

/**
 * 明确的位图白名单。
 *
 * 旧实现是「放行所有 `image/*`，只排除 `+xml`」——黑名单思路下，任何新出现的
 * `image/xxx`（以及结构上并不是位图的类型）都会默认放行。同源代理应当用白名单：
 * 只列浏览器能当作位图解码的常见类型，其余一律 415，未知类型宁可拒绝。
 */
const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/jpg', // 非标准写法，但部分 CDN 仍在用
  'image/pjpeg', // 老 IE 时代的 JPEG 别名，兼容历史源
  'image/png',
  'image/apng',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
  'image/x-ms-bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/heic',
  'image/heif',
]);

/**
 * 只允许位图。`image/svg+xml` 及其它 `image/*+xml` 一律拒绝：
 * SVG 作为独立文档打开时可以内嵌脚本，经同源代理后会带上站点源的权限，
 * 即使响应带 `X-Content-Type-Options: nosniff` 也不该默认放行。
 */
export function isAllowedImageContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  return ALLOWED_IMAGE_CONTENT_TYPES.has(normalized);
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
  /** 是否因总耗时上限触发取消，供路由把超时映射成 504 而不是笼统的 500 */
  readonly timedOut: boolean;
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
  let timedOut = false;
  const abortByClient = () => controller.abort();
  const abortByTimeout = () => {
    timedOut = true;
    controller.abort();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (clientSignal?.aborted) {
    abortByClient();
  } else {
    clientSignal?.addEventListener('abort', abortByClient, { once: true });
  }

  if (!controller.signal.aborted) {
    timer = setTimeout(abortByTimeout, timeoutMs);
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    releaseTimeout: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export type BoundedBodyResult =
  | { ok: true; bytes: Uint8Array; byteLength: number }
  | { ok: false; reason: 'too-large' };

/**
 * 把响应体完整读到上限再返回。
 *
 * 图片代理此前用流式转发：无 Content-Length 时超限只能 `controller.error()`，
 * 此时 200 响应头已经带着 `public, s-maxage=半年` 发出，客户端拿不到 413，
 * CDN 还有可能缓存一个被截断的响应。改为先缓冲（上限 8MB，常见海报远小于此）
 * 后，成功响应一定有准确 Content-Length，失败响应一定是明确的 4xx/5xx，
 * `<img onError>` 才能可靠回退到占位图。
 *
 * 超时 / 客户端取消会由 `reader.read()` 抛出，这里取消上游后原样抛出，
 * 交给调用方按 `timedOut` / `request.signal.aborted` 映射成 HTTP 状态码。
 *
 * 内存：多 chunk 响应在合并时会短暂同时存在「所有 chunk」与「合并后的 buffer」
 * 两份数据，峰值接近 2 × 上限（约 16MB，未计运行时额外开销）。常见海报远小于
 * 8MB，暂不为此改写成预分配；若 Preview 实测 Edge 内存吃紧，再按 Content-Length
 * 预分配精确 buffer 边读边填。
 */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes = MAX_PROXIED_IMAGE_BYTES
): Promise<BoundedBodyResult> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        // 上游可能同时出错，cancel 失败不应把 413 变成 502
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too-large' };
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  if (chunks.length === 1) {
    return { ok: true, bytes: chunks[0], byteLength: received };
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes, byteLength: received };
}
