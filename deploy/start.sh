#!/bin/bash
cd "$(dirname "$0")" || exit 1
REPO="https://github.com/mahngueloh/Vanta-effect-.git"

if [ ! -d .git ]; then
  git init -q -b main
  git remote add origin "$REPO"
fi

if git fetch -q origin main; then
  [ -f .env ] && cp .env .env.keep
  git reset -q --hard origin/main
  git branch -q -u origin/main 2>/dev/null
  if [ -f .env.keep ]; then mv -f .env.keep .env; fi
  echo "[update] synced with GitHub"
else
  echo "[update] could not reach GitHub, starting current files"
fi

[ -f package.json ] && npm install --no-audit --no-fund
exec /usr/local/bin/node /home/container/index.js