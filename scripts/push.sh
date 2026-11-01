#!/usr/bin/env bash
# 推送脚本：处理 Actions 自动提交造成的冲突
# 策略：数据文件（schedule/catalog/names）以远端为准（Actions 刚跑过，是最新的），
#      代码文件保留本地版本。
set -e
export PATH="$HOME/.local/bin:$PATH"
export GH_CONFIG_DIR=/tmp/ghcfg
cd "$(dirname "$0")"

REPO="zxy8125ss/game-on-rebuild"

git fetch origin -q
git add -A
if git diff --cached --quiet; then
  echo "没有新改动"
  exit 0
fi

# 记录本地代码文件的 blob
LOCAL=$(git diff --cached --name-only | grep -v '^data/' || true)
echo "本地代码改动: ${LOCAL:-无}"

git rebase origin/main 2>&1 | tail -3 || {
  echo "--- rebase 冲突，用本地版本解决数据文件 ---"
  for f in data/schedule.json data/catalog.json data/names.json; do
    if [ -f "$f" ]; then
      git checkout --ours "$f" 2>/dev/null || true
      git add "$f" 2>/dev/null || true
    fi
  done
  git -c core.editor=true rebase --continue
}

git push -q origin main
echo "✅ 已推送 $(git rev-parse --short HEAD)"
