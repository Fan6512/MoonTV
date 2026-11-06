/**
 * 自动换源并发竞态回归测试（PR #2 复审补充）。
 *
 * 纯状态机测试只能证明计数规则正确，无法覆盖 React 与异步调用链之间的竞态：
 * `autoSwitchSource()` 同步消费计数后，`handleSourceChange()` 会先
 * `await deleteSkipConfig()` / `await saveSkipConfig()` 才写状态。
 *
 * 这里用可控的 deferred Promise 复现真实链路：
 *   runAutoSwitch → apply（异步窗口）→ canCommit 闸门 → 提交 → finish
 * 其中 canCommit 的检查位置与 usePlayEngine.handleSourceChange 一致，
 * 因此「连续错误事件」「手动抢占」「切集作废」的行为与生产代码同源。
 */

import {
  AutoSourceSwitchState,
  AutoSwitchCandidate,
  runAutoSwitch,
  SourceSwitchCoordinator,
} from '../auto-source-switch';

const CANDIDATES: AutoSwitchCandidate[] = [
  { source: 'A', id: '1', episodes: ['e1', 'e2', 'e3'] },
  { source: 'B', id: '2', episodes: ['e1', 'e2', 'e3'] },
  { source: 'C', id: '3', episodes: ['e1', 'e2', 'e3'] },
  { source: 'D', id: '4', episodes: ['e1', 'e2', 'e3'] },
  { source: 'E', id: '5', episodes: ['e1', 'e2', 'e3'] },
];

/** 让 Promise.resolve().then(...).finally(...) 这条微任务链全部跑完 */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

interface PendingSwitch {
  source: string;
  token: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

function createHarness(options: { failApply?: boolean } = {}) {
  const state = new AutoSourceSwitchState();
  const coordinator = new SourceSwitchCoordinator();
  const attempted: string[] = [];
  const applied: string[] = [];
  const errors: string[] = [];
  const pending: PendingSwitch[] = [];
  let current = 'A';
  // 生产代码里 currentSource/currentId 与候选列表的 id 是同一套，
  // 这里必须保持一致，否则状态机会把「当前源」误判成一个新候选。
  const currentId = () =>
    CANDIDATES.find((item) => item.source === current)?.id ?? '';

  const runtime = {
    state,
    coordinator,
    snapshot: () => ({
      currentSource: current,
      currentId: currentId(),
      candidates: CANDIDATES,
      episodeIndex: 0,
    }),
    apply: (candidate: AutoSwitchCandidate, token: number) =>
      new Promise<void>((resolve, reject) => {
        attempted.push(candidate.source);
        if (options.failApply) {
          reject(new Error('skip config save failed'));
          return;
        }
        pending.push({ source: candidate.source, token, resolve, reject });
      }),
    onNotice: () => undefined,
    onError: (message: string) => errors.push(message),
  };

  /** 模拟 handleSourceChange 在 await 之后、写状态之前的 canCommit 闸门 */
  const settle = async (index = 0) => {
    const item = pending[index];
    if (!item) throw new Error('no pending switch to settle');
    if (coordinator.canCommit(item.token)) {
      applied.push(item.source);
      current = item.source;
    }
    pending.splice(index, 1);
    item.resolve();
    await flush(); // 让 runAutoSwitch 的 .finally 执行 finish
  };

  /** 模拟用户手动选源：抢占锁并立即写出 */
  const manualSwitch = (source: string) => {
    const token = coordinator.begin('manual');
    if (token === null) throw new Error('manual switch must always preempt');
    if (coordinator.canCommit(token)) {
      applied.push(source);
      current = source;
    }
    coordinator.finish(token);
    state.reset();
  };

  return {
    runtime,
    state,
    coordinator,
    attempted,
    applied,
    errors,
    pending,
    settle,
    manualSwitch,
    get current() {
      return current;
    },
  };
}

describe('SourceSwitchCoordinator 基础语义', () => {
  it('自动换源进行中再次 begin(auto) 返回 null', () => {
    const c = new SourceSwitchCoordinator();
    const token = c.begin('auto');

    expect(c.busy).toBe(true);
    expect(c.begin('auto')).toBeNull();
    expect(token).toBe(1);
  });

  it('手动换源可以抢占并作废旧请求序号', () => {
    const c = new SourceSwitchCoordinator();
    const oldToken = c.begin('auto') as number;
    const newToken = c.begin('manual') as number;

    expect(newToken).toBeGreaterThan(oldToken);
    expect(c.canCommit(oldToken)).toBe(false);
    expect(c.canCommit(newToken)).toBe(true);
  });

  it('旧请求 finish 不会释放新请求的锁', () => {
    const c = new SourceSwitchCoordinator();
    const oldToken = c.begin('auto') as number;
    const newToken = c.begin('manual') as number;

    c.finish(oldToken);
    expect(c.busy).toBe(true);
    expect(c.canCommit(newToken)).toBe(true);

    c.finish(newToken);
    expect(c.busy).toBe(false);
  });

  it('invalidate 作废全部未完成请求并允许新一轮换源', () => {
    const c = new SourceSwitchCoordinator();
    const oldToken = c.begin('auto') as number;
    c.invalidate();

    expect(c.canCommit(oldToken)).toBe(false);
    expect(c.currentToken).toBe(0);
    expect(c.busy).toBe(false);
    expect(c.begin('auto')).not.toBeNull();
  });
});

/**
 * 换源尾部 100ms 关闭加载遮罩的定时器回归测试。
 *
 * `canCommit()` 要求 `inflight` 为真，而正常完成的换源会在 `finally` 里
 * `finish()`，此时锁已释放。若定时器用 `canCommit()` 判断，旧回调会永远
 * 被跳过；反过来若不做任何判断，旧回调又会关掉新换源的遮罩。
 * 正确语义是 `isLatest()`：只看「之后有没有更新的换源」。
 */
describe('换源尾部的延迟收尾（100ms 关闭遮罩）', () => {
  it('正常完成后 isLatest 仍为 true，而 canCommit 已为 false', () => {
    const c = new SourceSwitchCoordinator();
    const token = c.begin('auto') as number;

    c.finish(token);

    expect(c.canCommit(token)).toBe(false); // 锁已释放，不能写状态…
    expect(c.isLatest(token)).toBe(true); // …但仍是最后一次换源，可以收尾
  });

  it('新换源开始后旧 token 立即失效', () => {
    const c = new SourceSwitchCoordinator();
    const oldToken = c.begin('auto') as number;
    c.finish(oldToken);

    const newToken = c.begin('manual') as number;

    expect(c.isLatest(oldToken)).toBe(false);
    expect(c.isLatest(newToken)).toBe(true);
  });

  it('切集 invalidate 后旧定时器失效', () => {
    const c = new SourceSwitchCoordinator();
    const token = c.begin('auto') as number;
    c.finish(token);

    c.invalidate();

    expect(c.isLatest(token)).toBe(false);
  });

  it('旧定时器不关闭新换源的加载遮罩', () => {
    const coordinator = new SourceSwitchCoordinator();
    let loading = false;
    const pendingTimers: Array<() => void> = [];
    // 与 handleSourceChange 尾部一致：100ms 后仅在仍是最新换源时收起遮罩
    const scheduleHide = (token: number) =>
      pendingTimers.push(() => {
        if (coordinator.isLatest(token)) loading = false;
      });

    // 第一次换源完成并排定收尾
    const first = coordinator.begin('auto') as number;
    loading = true;
    coordinator.finish(first);
    scheduleHide(first);

    // 100ms 内用户手动换源，且新换源已经打开了遮罩
    const second = coordinator.begin('manual') as number;
    loading = true;
    coordinator.finish(second);

    // 旧定时器现在才触发
    pendingTimers.forEach((fire) => fire());

    expect(loading).toBe(true);
  });
});

describe('连续错误事件的异步竞态', () => {
  it('同一轮播放失败连续触发 3 次错误回调，只发起 1 次换源且只消耗 1 次计数', async () => {
    const h = createHarness();

    runAutoSwitch(h.runtime, 'fatal');
    runAutoSwitch(h.runtime, 'fatal');
    runAutoSwitch(h.runtime, 'fatal');
    await flush();

    expect(h.attempted).toEqual(['B']);
    expect(h.state.switchCount).toBe(1);
    expect(h.pending).toHaveLength(1);
  });

  it('每次换源完成后锁才释放，3 次后按上限停止', async () => {
    const h = createHarness();

    for (let i = 0; i < 3; i += 1) {
      runAutoSwitch(h.runtime, 'fatal');
      await flush();
      await h.settle(0);
      expect(h.coordinator.busy).toBe(false);
    }

    expect(h.applied).toEqual(['B', 'C', 'D']);
    expect(h.state.switchCount).toBe(3);

    runAutoSwitch(h.runtime, 'fatal');
    await flush();
    expect(h.attempted).toEqual(['B', 'C', 'D']);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain('已自动尝试 3 个片源仍未成功');
  });

  it('异步窗口内的第二次错误不会选出 C 源、也不会让两个换源并发落地', async () => {
    const h = createHarness();

    runAutoSwitch(h.runtime, 'first');
    await flush();
    runAutoSwitch(h.runtime, 'second'); // apply 尚未 resolve 时再次触发
    await flush();

    expect(h.attempted).toEqual(['B']);
    expect(h.coordinator.busy).toBe(true);

    await h.settle(0);
    expect(h.applied).toEqual(['B']);
    expect(h.current).toBe('B');
  });

  it('手动换源抢占后，旧自动换源完成时不得覆盖用户选的源', async () => {
    const h = createHarness();

    runAutoSwitch(h.runtime, 'fatal');
    await flush();
    expect(h.pending).toHaveLength(1);

    h.manualSwitch('E');
    await h.settle(0); // 旧的 B 请求此刻才从 await 返回

    expect(h.applied).toEqual(['E']);
    expect(h.current).toBe('E');
    expect(h.coordinator.busy).toBe(false);
  });

  it('切集作废后，未落地的自动换源不写回状态', async () => {
    const h = createHarness();

    runAutoSwitch(h.runtime, 'fatal');
    await flush();

    h.coordinator.invalidate(); // handleEpisodeChange 开头
    h.state.reset();
    await h.settle(0);

    expect(h.applied).toEqual([]);
    expect(h.current).toBe('A');
  });

  it('apply 抛错时释放锁并上报错误，不会永久卡死自动换源', async () => {
    const h = createHarness({ failApply: true });

    runAutoSwitch(h.runtime, 'fatal');
    await flush();

    expect(h.errors).toEqual(['skip config save failed']);
    expect(h.coordinator.busy).toBe(false);

    runAutoSwitch(h.runtime, 'fatal');
    await flush();
    expect(h.state.switchCount).toBe(2);
  });

  it('候选耗尽 / 达到上限时不占用锁，后续可立即手动换源', async () => {
    const state = new AutoSourceSwitchState();
    const coordinator = new SourceSwitchCoordinator();
    const errors: string[] = [];
    const runtime = {
      state,
      coordinator,
      snapshot: () => ({
        currentSource: 'A',
        currentId: '1',
        candidates: [CANDIDATES[0]],
        episodeIndex: 0,
      }),
      apply: () => undefined,
      onNotice: () => undefined,
      onError: (message: string) => errors.push(message),
    };

    runAutoSwitch(runtime, 'fatal');
    await flush();

    expect(errors[0]).toContain('已无可用备用片源');
    expect(coordinator.busy).toBe(false);
    expect(coordinator.begin('manual')).not.toBeNull();
  });
});
