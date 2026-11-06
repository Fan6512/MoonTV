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

/* -------------------------------------------------------------------------- *
 * 换源并发协调
 * -------------------------------------------------------------------------- */

export type SourceSwitchKind = 'auto' | 'manual';

/**
 * 换源中锁 + 请求序号。
 *
 * `autoSwitchSource()` 会同步消费一次状态机计数，但真正的换源动作
 * `handleSourceChange()` 在写状态前要 await 跳过片头配置的删除与保存。
 * 同一轮播放失败若连续触发多次 HLS 错误回调，就会出现两个异步换源并发：
 * 前者选 B、后者选 C，计数被重复消耗，最终生效的源由完成顺序决定。
 *
 * 规则：
 *  - `auto` 在已有换源进行时直接拒绝（返回 null），不消耗状态机计数；
 *  - `manual` / 切集可以抢占并作废旧请求，旧请求 await 回来后
 *    `canCommit()` 为 false，不得写回状态覆盖用户的新选择；
 *  - 谁 `begin()` 谁 `finish()`，`finish` 只释放序号仍最新的那一把锁。
 */
export class SourceSwitchCoordinator {
  private inflight = false;

  private sequence = 0;

  private latestToken = 0;

  get busy(): boolean {
    return this.inflight;
  }

  /** 当前有效的请求序号（0 表示已全部作废），供诊断与测试使用 */
  get currentToken(): number {
    return this.latestToken;
  }

  begin(kind: SourceSwitchKind): number | null {
    if (kind === 'auto' && this.inflight) return null;
    this.sequence += 1;
    this.latestToken = this.sequence;
    this.inflight = true;
    return this.latestToken;
  }

  /** await 之后、写任何状态之前必须过这道闸门 */
  canCommit(token: number): boolean {
    return this.inflight && token === this.latestToken;
  }

  finish(token: number): void {
    if (token !== this.latestToken) return;
    this.inflight = false;
  }

  /** 切集 / 换片 / 组件卸载：作废所有未落地的换源 */
  invalidate(): void {
    this.sequence += 1;
    this.latestToken = 0;
    this.inflight = false;
  }
}

export interface AutoSwitchRuntime {
  state: AutoSourceSwitchState;
  coordinator: SourceSwitchCoordinator;
  /** 每次决策都读最新 ref，避免闭包过期 */
  snapshot: () => Parameters<AutoSourceSwitchState['requestSwitch']>[0];
  /** 真正执行换源（内部 await），token 用于完成后判定是否仍可提交 */
  apply: (
    candidate: AutoSwitchCandidate,
    token: number
  ) => void | Promise<void>;
  onNotice: (candidate: AutoSwitchCandidate) => void;
  onError: (message: string) => void;
  log?: (message: string) => void;
}

/**
 * 自动换源调度：把「取锁 → 状态机决策 → 异步应用 → 释放锁」收在一个纯逻辑函数里，
 * 生产代码与竞态回归测试跑的是同一份实现。
 */
export function runAutoSwitch(
  runtime: AutoSwitchRuntime,
  reason: string
): void {
  const { coordinator, state } = runtime;
  if (coordinator.busy) return;

  const token = coordinator.begin('auto');
  if (token === null) return;

  const decision = state.requestSwitch(runtime.snapshot());
  if (decision.kind !== 'switch') {
    coordinator.finish(token);
    runtime.onError(
      decision.kind === 'limit-reached'
        ? `播放失败：${reason}。已自动尝试 ${decision.switchCount} 个片源仍未成功，请手动切换片源`
        : `播放失败：${reason}。已无可用备用片源，请手动选择`
    );
    return;
  }

  runtime.log?.(
    `[auto-switch] ${reason} → ${decision.candidate.source}:${decision.candidate.id}`
  );
  runtime.onNotice(decision.candidate);

  void Promise.resolve()
    .then(() => runtime.apply(decision.candidate, token))
    .catch((error: unknown) => {
      if (coordinator.canCommit(token)) {
        runtime.onError(
          error instanceof Error ? error.message : '自动换源失败'
        );
      }
    })
    .finally(() => coordinator.finish(token));
}
