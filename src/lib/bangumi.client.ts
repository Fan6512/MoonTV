'use client';
export interface BangumiCalendarData {
  weekday: {
    en: string;
  };
  items: {
    id: number;
    name: string;
    name_cn: string;
    // 以下字段在 Bangumi 真实数据里都可能缺失：
    // 例如 id 498559「Electro Andes」整条没有 images，rating / air_date 也并非必有。
    rating?: {
      score?: number;
    };
    air_date?: string;
    images?: {
      large?: string;
      common?: string;
      medium?: string;
      small?: string;
      grid?: string;
    };
  }[];
}

export async function GetBangumiCalendarData(): Promise<BangumiCalendarData[]> {
  try {
    const response = await fetch('/api/bangumi/calendar', {
      headers: {
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) return [];
    return data as BangumiCalendarData[];
  } catch (error) {
    console.error('Bangumi 日历请求失败:', error);
    return [];
  }
}
