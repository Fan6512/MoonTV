/**
 * 片名归一化：用于「同一部作品」的跨源判定。
 *
 * 背景：各采集站对同一部片的写法不统一——
 *   量子 →「九门」  豪华 →「九门(2026)」  百度云 →「九门2026」
 * 三者在片库里指的是同一部剧，但严格字符串比较会把它们当成三部不同的作品，
 * 导致播放页的换源列表只显示其中一组（实测 10 个源缩水到 4 个）。
 *
 * 这里只做**低风险**归一化：去掉年份后缀与括号年份。
 * 刻意不处理「第X季」「上部/下部」——那些是不同的内容，合并进来会串源。
 */
export function normalizeVideoTitle(title: string): string {
  if (!title) return '';

  const base = title.trim().replace(/\s+/g, ' ').toLowerCase();

  const stripped = base
    // 括号包裹的年份：(2026) （2026） [2026] 【2026】
    .replace(/[（(\[【]\s*(19|20)\d{2}\s*[)）\]】]/g, '')
    // 结尾的裸年份：九门2026 / 九门 2026 / 九门.2026 / 九门-2026
    .replace(/[\s._,·\-–—~]*(19|20)\d{2}$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 「1921」这类片名本身就是一个年份，剥完会变成空串，此时保留原值
  return stripped || base;
}

/**
 * 判断两个片名是否指向同一部作品。
 */
export function isSameVideoTitle(a: string, b: string): boolean {
  return normalizeVideoTitle(a) === normalizeVideoTitle(b);
}
