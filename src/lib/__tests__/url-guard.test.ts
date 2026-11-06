/**
 * 媒体代理主机白名单回归测试（Batch 0）。
 *
 * 修复前图片与视频共用一份 `M3U8_PROXY_ALLOW_HOSTS`，生产上要么误拦截
 * 图片域名，要么只能放行全部。现在图片代理读 `IMAGE_PROXY_ALLOW_HOSTS`，
 * 未配置时回退到视频白名单，保持向后兼容。
 */

import { validateMediaUrl } from '../url-guard';

const IMAGE_ENV = 'IMAGE_PROXY_ALLOW_HOSTS';
const VIDEO_ENV = 'M3U8_PROXY_ALLOW_HOSTS';

const originalImage = process.env[IMAGE_ENV];
const originalVideo = process.env[VIDEO_ENV];

beforeEach(() => {
  delete process.env[IMAGE_ENV];
  delete process.env[VIDEO_ENV];
});

afterAll(() => {
  if (originalImage === undefined) delete process.env[IMAGE_ENV];
  else process.env[IMAGE_ENV] = originalImage;
  if (originalVideo === undefined) delete process.env[VIDEO_ENV];
  else process.env[VIDEO_ENV] = originalVideo;
});

describe('未配置白名单（默认，向后兼容）', () => {
  it('公网图片与视频域名都放行', () => {
    expect(
      validateMediaUrl('https://img.example.com/a.jpg', undefined, 'image').ok
    ).toBe(true);
    expect(
      validateMediaUrl('https://vod.example.com/a.m3u8', undefined, 'video').ok
    ).toBe(true);
  });

  it('内网 / 云元数据地址仍然被拦截', () => {
    expect(
      validateMediaUrl(
        'http://169.254.169.254/latest/meta-data',
        undefined,
        'image'
      ).ok
    ).toBe(false);
    expect(
      validateMediaUrl('http://127.0.0.1:8080/a.jpg', undefined, 'video').ok
    ).toBe(false);
  });

  it('协议与认证信息校验不受影响', () => {
    expect(validateMediaUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateMediaUrl('https://user:pass@img.example.com/a.jpg').ok).toBe(
      false
    );
  });
});

describe('只配置视频白名单', () => {
  beforeEach(() => {
    process.env[VIDEO_ENV] = '*.video.test';
  });

  it('视频代理只放行视频域名', () => {
    expect(
      validateMediaUrl('https://cdn.video.test/a.m3u8', undefined, 'video').ok
    ).toBe(true);
    expect(
      validateMediaUrl('https://img.example.com/a.jpg', undefined, 'video').ok
    ).toBe(false);
  });

  it('图片代理回退到视频白名单，不改变旧部署行为', () => {
    expect(
      validateMediaUrl('https://cdn.video.test/a.jpg', undefined, 'image').ok
    ).toBe(true);
    expect(
      validateMediaUrl('https://img.example.com/a.jpg', undefined, 'image').ok
    ).toBe(false);
  });

  it('通配符不会误匹配相似域名', () => {
    expect(
      validateMediaUrl('https://evil-video.test/a.m3u8', undefined, 'video').ok
    ).toBe(false);
  });
});

describe('图片与视频白名单分离', () => {
  beforeEach(() => {
    process.env[IMAGE_ENV] = '*.img.test';
    process.env[VIDEO_ENV] = '*.video.test';
  });

  it('图片代理只放行图片域名', () => {
    expect(
      validateMediaUrl('https://cdn.img.test/a.jpg', undefined, 'image').ok
    ).toBe(true);
    expect(
      validateMediaUrl('https://cdn.video.test/a.jpg', undefined, 'image').ok
    ).toBe(false);
  });

  it('视频代理只放行视频域名', () => {
    expect(
      validateMediaUrl('https://cdn.video.test/a.m3u8', undefined, 'video').ok
    ).toBe(true);
    expect(
      validateMediaUrl('https://cdn.img.test/a.m3u8', undefined, 'video').ok
    ).toBe(false);
  });

  it('extraAllowHosts 仍然对两种用途生效', () => {
    expect(
      validateMediaUrl('https://extra.test/a.jpg', ['extra.test'], 'image').ok
    ).toBe(true);
    expect(
      validateMediaUrl('https://extra.test/a.m3u8', ['extra.test'], 'video').ok
    ).toBe(true);
  });
});
