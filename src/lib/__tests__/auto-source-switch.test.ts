/**
 * 自动换源状态机回归测试（Batch 0）。
 *
 * 修复前计数重置放在依赖 [currentEpisodeIndex, currentSource, currentId]
 * 的 effect 里；自动换源会改后两个状态 → 计数永远归零 →
 * MAX_AUTO_SOURCE_SWITCHES 不生效，A↔B 无限重连。
 * 现在状态只由显式的 reset()（切集 / 手动换源 / 换片）清零。
 */

import {
  AutoSourceSwitchState,
  AutoSwitchCandidate,
  candidateKey,
  MAX_AUTO_SOURCE_SWITCHES,
} from '../auto-source-switch';

const CANDIDATES = [
  { source: 'A', id: '1', episodes: ['e1', 'e2', 'e3'] },
  { source: 'B', id: '2', episodes: ['e1', 'e2', 'e3'] },
  { source: 'C', id: '3', episodes: ['e1', 'e2', 'e3'] },
  { source: 'D', id: '4', episodes: ['e1', 'e2', 'e3'] },
  { source: 'E', id: '5', episodes: ['e1', 'e2', 'e3'] },
];

function request(
  state: AutoSourceSwitchState,
  currentSource: string,
  currentId: string,
  candidates: AutoSwitchCandidate[] = CANDIDATES,
  episodeIndex = 0
) {
  return state.requestSwitch({
    currentSource,
    currentId,
    candidates,
    episodeIndex,
  });
}

describe('连续自动换源', () => {
  it('A→B→C 逐步累计次数，源/ID 变化本身不会把计数清零', () => {
    const state = new AutoSourceSwitchState();

    const first = request(state, 'A', '1');
    expect(first.kind).toBe('switch');
    expect(first.switchCount).toBe(1);

    // 模拟自动换源改了 currentSource / currentId：不调用 reset()
    const second = request(state, 'B', '2');
    expect(second.kind).toBe('switch');
    expect(second.switchCount).toBe(2);

    const third = request(state, 'C', '3');
    expect(third.kind).toBe('switch');
    expect(third.switchCount).toBe(3);
  });

  it(`连续失败达到上限 ${MAX_AUTO_SOURCE_SWITCHES} 次后停止自动换源`, () => {
    const state = new AutoSourceSwitchState();
    request(state, 'A', '1');
    request(state, 'B', '2');
    request(state, 'C', '3');

    const fourth = request(state, 'D', '4');
    expect(fourth.kind).toBe('limit-reached');
    expect(fourth.switchCount).toBe(MAX_AUTO_SOURCE_SWITCHES);
    expect(state.switchCount).toBe(MAX_AUTO_SOURCE_SWITCHES);
  });

  it('不会回到本集已经试过的源（避免 A↔B 横跳）', () => {
    const state = new AutoSourceSwitchState();
    const first = request(state, 'A', '1');
    expect(first.kind === 'switch' && first.candidate.source).toBe('B');

    const second = request(state, 'B', '2', [CANDIDATES[0], CANDIDATES[1]]);
    expect(second.kind).toBe('no-candidate');
  });
});

describe('候选筛选', () => {
  it('候选源耗尽时返回 no-candidate', () => {
    const state = new AutoSourceSwitchState();
    const decision = request(state, 'A', '1', [CANDIDATES[0]]);

    expect(decision.kind).toBe('no-candidate');
    expect(state.switchCount).toBe(0);
  });

  it('跳过没有剧集列表的候选', () => {
    const state = new AutoSourceSwitchState();
    const decision = request(state, 'A', '1', [
      { source: 'X', id: 'x' },
      { source: 'B', id: '2', episodes: [] },
      CANDIDATES[1],
    ]);

    expect(decision.kind === 'switch' && decision.candidate.source).toBe('B');
  });

  it('跳过集数不多于当前集数的候选（切过去只能回到第一集）', () => {
    const state = new AutoSourceSwitchState();
    const decision = request(
      state,
      'A',
      '1',
      [
        { source: 'SHORT', id: 's', episodes: ['e1', 'e2'] },
        { source: 'LONG', id: 'l', episodes: ['e1', 'e2', 'e3'] },
      ],
      2
    );

    expect(decision.kind === 'switch' && decision.candidate.source).toBe(
      'LONG'
    );
  });
});

describe('显式 reset 的时机', () => {
  it('手动换源后重新计数并可再次选择之前试过的源', () => {
    const state = new AutoSourceSwitchState();
    request(state, 'A', '1');
    request(state, 'B', '2');
    expect(state.switchCount).toBe(2);

    state.reset();
    expect(state.switchCount).toBe(0);
    expect(state.triedKeys).toEqual([]);

    const afterManual = request(state, 'C', '3', [
      CANDIDATES[0],
      CANDIDATES[1],
      CANDIDATES[2],
    ]);
    expect(afterManual.kind === 'switch' && afterManual.candidate.source).toBe(
      'A'
    );
    expect(afterManual.switchCount).toBe(1);
  });

  it('切集后重新给满自动换源机会', () => {
    const state = new AutoSourceSwitchState();
    request(state, 'A', '1');
    request(state, 'B', '2');
    request(state, 'C', '3');

    state.reset(); // 模拟切集
    const afterEpisodeChange = request(state, 'A', '1');
    expect(afterEpisodeChange.kind).toBe('switch');
    expect(afterEpisodeChange.switchCount).toBe(1);
  });

  it('上限可以自定义（便于测试与将来按配置调整）', () => {
    const state = new AutoSourceSwitchState(1);
    expect(request(state, 'A', '1').kind).toBe('switch');
    expect(request(state, 'B', '2').kind).toBe('limit-reached');
  });
});

describe('candidateKey', () => {
  it('用 source:id 作为唯一标识', () => {
    expect(candidateKey('A', '1')).toBe('A:1');
  });
});
