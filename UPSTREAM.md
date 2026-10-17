# 上游同步指南

本仓库是 [Stardm0/MoonTV](https://github.com/Stardm0/MoonTV) 的下游分支，在保留上游功能的基础上做了一批本地优化。
本文档的目的只有一个：**当上游再次更新时，能安全、可追溯地把改动合进来，而不是推倒重来。**

---

## 一、远端拓扑

| 远端 | 地址 | 权限 | 用途 |
| --- | --- | --- | --- |
| `origin` | `Fan6512/MoonTV` | 读写 | 自己的仓库，**Vercel 部署源** |
| `upstream` | `Stardm0/MoonTV` | **只读**（push URL 已置为 `DISABLED`） | 上游，只 fetch 不 push |

> `upstream` 的 push 地址被刻意禁用，防止手滑把本地改动推到别人的仓库。

---

## 二、铁律：用 merge，不要 rebase

```bash
git merge upstream/main     # ✅
git rebase upstream/main    # ❌ 不要
```

原因：两边同时在改同一批文件（尤其 `usePlayEngine.ts`）。

- `rebase` 会把本地 9 个提交逐个重放到上游的每一个提交之上 → **同一个冲突要解 N 遍**；
- `rebase` 改写历史后，`git log`/`git blame` 无法回答"这行为什么改"；
- `merge` 只解一次冲突，且留下一个明确的合并节点，日后可以整体 revert。

---

## 三、一键同步

```bash
# 只预检，不动工作区（推荐先跑这个）
bash scripts/sync-upstream.sh --dry-run

# 确认无误后正式合并
bash scripts/sync-upstream.sh

# 合并成功后
pnpm install && pnpm typecheck && pnpm lint:strict
git commit -m "merge: 同步上游 main"
git push origin main
```

脚本会自动完成：工作区洁净检查 → 拉取上游 → **冲突预检并列出文件** → 建 `backup/pre-sync-*` 备份分支 → 执行 merge。

> 网络提示：本机拉 GitHub 常需代理。
> `https_proxy=http://127.0.0.1:7890 bash scripts/sync-upstream.sh`

---

## 四、本地补丁清单（冲突时的判断依据）

合上游时如果某个文件冲突，**先查这张表**：左边是我们的意图，右边是处理方式。

| 文件 | 本地改了什么 | 为什么 | 冲突时怎么处理 |
| --- | --- | --- | --- |
| `config.json` | 源清单 10 → 13 | 实测剔除不可用/重复源，补入可用源 | **保留本地源清单**。上游这份多为示例配置，不值得覆盖 |
| `src/lib/utils.ts` | 拆成 3 个模块，只留 `getRequestTimeout` | 原文件顶层静态 `import hls.js`，害得全站首包多 150KB | 上游若在本文件新增函数，把它迁到 `image-utils`/`html-utils`/`video-probe` 对应位置，**别再把重依赖放回 utils** |
| `src/lib/image-utils.ts`<br>`src/lib/html-utils.ts`<br>`src/lib/video-probe.ts` | 新增 | 职责拆分 | 纯新增文件，一般不冲突 |
| `src/lib/title-utils.ts` | 新增 `normalizeVideoTitle` | 各源片名写法不一（九门 / 九门2026 / 九门(2026)），严格比较会把同一部剧拆成三组 | 纯新增，一般不冲突 |
| `src/app/play/usePlayEngine.ts` | ① 删建播前 500ms 硬延迟<br>② `/api/detail` 单源直连替代全站搜索流<br>③ 换源计数 effect 按生命周期拆分<br>④ 片名归一化匹配 | ① 该延迟是串行阻塞，直接叠加到首帧<br>② 首帧不该等最慢的源<br>③ 原逻辑导致自动换源上限失效、A↔B 无限重连<br>④ 见上 | **冲突高发区**。逐条对照：能保留就保留，上游若重构了同段逻辑，优先确认这 4 个行为是否还在 |
| `src/app/play/PlayClient.tsx` | 3 个面板改 `dynamic` + 条件挂载 | 避免 crypto-js + mux.js（约 320KB）进首包 | 上游若新增重型面板，同样按需加载 |
| `src/components/EpisodeSelector.tsx` | 测速改 4 路并发池 | 原实现一次性并发 6 个，抢带宽导致大量探测超时 | 冲突时保留并发池 |
| `src/components/VideoCard.tsx` | 海报二次失败后隐藏 img | 原逻辑只重试一次，失败后浏览器会画出坏图标 | 保留 |
| `src/app/api/**/route.ts`（8 个） | 声明 `export const dynamic = 'force-dynamic'` | 读 cookie / `request.url` 的 GET 路由会在 build 阶段被误判为可静态生成，抛 `DYNAMIC_SERVER_USAGE` 被 catch 吞成假错误 | 上游若新增同类路由，按同一判据补声明 |

---

## 五、冲突高发区

按历史经验排序：

1. **`src/app/play/usePlayEngine.ts`**（2791 行，上游主战场）——本地改了 4 处，最容易撞车；
2. **`src/components/EpisodeSelector.tsx`**——上游也在持续改测速/换源 UI；
3. **`src/app/play/PlayClient.tsx`**——面板结构变动频繁；
4. **`package.json`**——本地**刻意没有改动**，就是为了不在这个高频文件上制造冲突。

---

## 六、合并后必查清单

| 检查 | 命令 / 方法 | 期望 |
| --- | --- | --- |
| 依赖是否变化 | `pnpm install` | 无报错 |
| 类型 | `pnpm typecheck` | 0 错误 |
| Lint | `pnpm lint:strict` | 0 error（存量 warning 可忽略） |
| 首帧优化是否还在 | 进播放页看 Network | 不再请求全站 `/api/search` 流，改走 `/api/detail` |
| 换源数量是否正常 | 播放页「换源」tab | 与 `config.json` 源数一致（当前 13） |
| 构建告警是否复发 | Vercel 构建日志 | 无 `Dynamic server usage` |

---

## 七、回滚

```bash
# 找最近的备份
git branch --list 'backup/pre-sync-*'

# 放弃未提交的合并
git merge --abort

# 已提交但想退回去
git reset --hard backup/pre-sync-YYYYmmdd-HHMMSS

# 已推送、只撤某一块
git revert -m 1 <merge-commit>
```

---

## 八、基线与版本

`v4.3.0-fan.1` 标记了「上游 v4.3.0 + 本轮全部本地优化」的稳定状态。
以后每次同步上游并验证通过，建议打一个新 tag：

```bash
git tag -a v4.4.0-fan.1 -m "同步上游 v4.4.0 + 本地优化"
git push origin --tags
```

这样任何时候都能回答：**当前线上跑的是哪一版上游 + 哪一批本地改动。**
