/**
 * 自动换源状态机（纯逻辑，可与 React 生命周期解耦做回归测试）。
 *
 * 关键语义：**只有「切集 / 手动换源 / 换片」才调用 reset()**。
 * 自动换源本身会改变 currentSource / currentId，如果把状态重置挂在监听这些
 * 状态的 effect 上，计数会在每次换源后被清零，MAX_AUTO_SOURCE_SWITCHES
 * 永远不生效，播放器会在 A↔B 之间无限重连。
 *
 * 缓存清理、预取终止等副作用仍属于「源或集数变化」的 effect，与本状态机无关。
 */

/** 同一集内最多自动换源次数 */
export const MAX_AUTO_SOURCE_SWITCHES = 3;

export interface AutoSwitchCandidate {
  source: string;
  id: string;
  episodes?: unknown[];
  title?: string;
}

export type AutoSwitchDecision =
  | { kind: 'switch'; candidate: AutoSwitchCandidate; switchCount: number }
  | { kind: 'limit-reached'; switchCount: number }
  | { kind: 'no-candidate'; switchCount: number };

export function candidateKey(source: string, id: string): string {
  return `${source}:${id}`;
}

export class AutoSourceSwitchState {
  private readonly tried = new Set<string>();

  private count = 0;

  constructor(private readonly maxSwitches = MAX_AUTO_SOURCE_SWITCHES) {}

  /** 切集、手动换源、换片：清空「已试过的源」与自动换源次数 */
  reset(): void {
    this.tried.clear();
    this.count = 0;
  }

  get switchCount(): number {
    return this.count;
  }

  get triedKeys(): string[] {
    return Array.from(this.tried);
  }

  /**
   * 当前源被判定为不可自动恢复时，决定下一步动作。
   *
   * 候选依次排除：本集已试过的、没有剧集列表的、集数短于当前集数的
   * （切过去只能回到第一集，体验反而更差）。
   */
  requestSwitch({
    currentSource,
    currentId,
    candidates,
    episodeIndex,
  }: {
    currentSource: string;
    currentId: string;
    candidates: AutoSwitchCandidate[];
    episodeIndex: number;
  }): AutoSwitchDecision {
    this.tried.add(candidateKey(currentSource, currentId));

    if (this.count >= this.maxSwitches) {
      return { kind: 'limit-reached', switchCount: this.count };
    }

    const candidate = candidates.find((item) => {
      if (this.tried.has(candidateKey(item.source, item.id))) return false;
      if (!item.episodes || item.episodes.length === 0) return false;
      return item.episodes.length > episodeIndex;
    });

    if (!candidate) {
      return { kind: 'no-candidate', switchCount: this.count };
    }

    this.count += 1;
    this.tried.add(candidateKey(candidate.source, candidate.id));
    return { kind: 'switch', candidate, switchCount: this.count };
  }
}
