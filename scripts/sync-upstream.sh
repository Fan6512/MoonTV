#!/usr/bin/env bash
#
# 同步上游 Stardm0/MoonTV 到本地 main。
#
# 设计原则（为什么是 merge 而不是 rebase）：
#   上游是本项目的正式前身，两边都在改同一批文件。rebase 会把本地提交逐个
#   重放到上游的每一个提交之上，同一个冲突要解 N 遍，且改写历史后无法用
#   `git log` 追溯"当初为什么这么改"。merge 只解一次，历史完整保留。
#
# 用法：
#   bash scripts/sync-upstream.sh            # 正常同步
#   bash scripts/sync-upstream.sh --dry-run  # 只预检，不动工作区
#
set -uo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
LOCAL_BRANCH="${LOCAL_BRANCH:-main}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log()  { printf '\033[1;34m[sync]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[注意]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[中止]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 前置检查
git rev-parse --git-dir >/dev/null 2>&1 || die "当前目录不是 git 仓库"

if [ -n "$(git status --porcelain)" ]; then
  die "工作区有未提交的改动。先 commit 或 stash，避免把无关改动混进合并提交。"
fi

CURRENT=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT" != "$LOCAL_BRANCH" ]; then
  log "从 $CURRENT 切换到 $LOCAL_BRANCH"
  [ "$DRY_RUN" -eq 1 ] && die "--dry-run 模式下不切换分支，请先手动切到 $LOCAL_BRANCH"
  git switch "$LOCAL_BRANCH" || die "切换分支失败"
fi

# ---------------------------------------------------------------- 拉取
log "拉取 $UPSTREAM_REMOTE ..."
git fetch "$UPSTREAM_REMOTE" --prune --tags || die "拉取上游失败（网络问题？本机可能需要代理：https_proxy=http://127.0.0.1:7890）"

TARGET="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
BEHIND=$(git rev-list --count "HEAD..$TARGET")
AHEAD=$(git rev-list --count "$TARGET..HEAD")

if [ "$BEHIND" -eq 0 ]; then
  log "上游没有新提交，无需合并（本地领先 $AHEAD 个提交）"
  exit 0
fi

log "上游领先 $BEHIND 个提交，本地领先 $AHEAD 个提交"

# ---------------------------------------------------------------- 冲突预检
if git merge-tree --write-tree "HEAD" "$TARGET" >/dev/null 2>&1; then
  log "预检：无冲突"
  CONFLICT=0
else
  CONFLICT=1
  warn "预检：存在冲突，涉及以下文件（需人工判断保留哪边）"
  # merge-tree --name-only 首行是树的 OID，其余是冲突文件路径
  git merge-tree --write-tree --name-only "HEAD" "$TARGET" 2>/dev/null \
    | tail -n +2 | sed 's/^/    /'
  echo
  warn "冲突处理依据见仓库根目录 UPSTREAM.md 的「本地补丁清单」"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry-run 结束，未做任何改动"
  exit 0
fi

# ---------------------------------------------------------------- 备份
BACKUP="backup/pre-sync-$(date +%Y%m%d-%H%M%S)"
git branch "$BACKUP" || die "创建备份分支失败"
log "已备份到 $BACKUP"

# ---------------------------------------------------------------- 合并
if git merge --no-ff --no-commit "$TARGET"; then
  log "合并完成，无冲突。请确认后提交："
  echo "    git commit -m \"merge: 同步上游 $UPSTREAM_BRANCH（$BEHIND 个提交）\""
  echo
  log "提交前建议依次执行："
  echo "    pnpm install          # 上游可能调整依赖"
  echo "    pnpm typecheck"
  echo "    pnpm lint:strict"
else
  warn "合并停在冲突状态，工作区已保留冲突标记。"
  echo
  echo "  解决后：  git add <文件> && git commit"
  echo "  放弃本次：git merge --abort"
  echo "  彻底回滚：git switch -C $LOCAL_BRANCH $BACKUP"
  exit 2
fi
