/** @jest-environment node */

import { fetchDoubanData } from '@/lib/douban';

const URL = 'https://m.douban.com/rexxar/api/v2/subject/recent_hot/movie';

describe('fetchDoubanData Data Cache options', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('passes the requested revalidation period to Next.js fetch', async () => {
    const payload = { items: [{ id: '1' }] };
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(payload),
    });

    await expect(
      fetchDoubanData(URL, { revalidate: 7200 })
    ).resolves.toEqual(payload);

    const [requestUrl, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(requestUrl).toBe(URL);
    expect(options.next).toEqual({ revalidate: 7200 });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers).toMatchObject({
      Referer: 'https://movie.douban.com/',
      Origin: 'https://movie.douban.com',
    });
  });

  it('preserves the existing fetch behavior when no cache option is supplied', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ items: [] }),
    });

    await fetchDoubanData(URL);

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(options.next).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects an invalid revalidation period before making an upstream request', async () => {
    await expect(
      fetchDoubanData(URL, { revalidate: 0 })
    ).rejects.toThrow('Douban cache revalidate must be a positive number');

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
