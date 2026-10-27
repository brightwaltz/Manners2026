#!/bin/bash
# 全部の検査を 1 回で流す：bash tests/all.sh
# サイトの検査（check.mjs）→ 単体テスト（node --test）→ 通しの検査（e2e.mjs、e2e_k1〜k3、e2e_restore.mjs、e2e_guide.mjs）の順。
# 途中で失敗しても最後まで流し、失敗が 1 つでもあれば終了コード 1。
# E2E_SHOT_DIR などの環境変数は、そのまま各検査に渡る。
cd "$(dirname "$0")/.." || exit 1

failed=()
run() {
  echo
  echo "==== $* ===="
  if "$@"; then
    echo "---- 合格：$*"
  else
    echo "---- 不合格：$*"
    failed+=("$*")
  fi
}

run node tools/check.mjs
run node --test tests/*.test.mjs
run node tests/e2e.mjs
run node tests/e2e_k1.mjs
run node tests/e2e_k2.mjs
run node tests/e2e_k3.mjs
run node tests/e2e_restore.mjs
run node tests/e2e_guide.mjs

echo
if [ ${#failed[@]} -eq 0 ]; then
  echo "==== すべて合格（8 段）"
  exit 0
fi
echo "==== 不合格 ${#failed[@]} 段："
for f in "${failed[@]}"; do echo "  × $f"; done
exit 1
