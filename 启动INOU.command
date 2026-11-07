#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 22.13 或以上版本。'
  read -r 'reply?按回车退出'
  exit 1
fi
if node -e 'fetch("http://localhost:8787/api/health").then(r=>r.json()).then(v=>process.exit(v.ok && v.contentStorage===false ? 0 : 1)).catch(()=>process.exit(1))' 2>/dev/null; then
  open http://localhost:8787
  exit 0
fi
if [ ! -d node_modules ]; then npm ci; fi
npm run build
(sleep 1; open http://localhost:8787) &
npm start
