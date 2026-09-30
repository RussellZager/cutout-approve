#!/usr/bin/env bash
# Mutation arms: break one safety property in app.js, and prove the named test goes red.
# app.js is backed up with a checksum and restored by an EXIT trap.
#   test/mutation.sh            # all arms; exit 0 only if every arm went red and app.js is restored
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

APP=app.js
BACKUP=$(mktemp -t approve-app) || exit 2
cp "$APP" "$BACKUP"
SUM=$(shasum -a 256 "$APP" | cut -d' ' -f1)
restore() {
  cp "$BACKUP" "$APP"
  local now; now=$(shasum -a 256 "$APP" | cut -d' ' -f1)
  if [ "$now" != "$SUM" ]; then echo "RESTORE FAILED: app.js checksum $now != $SUM (backup at $BACKUP)"; exit 3; fi
  rm -f "$BACKUP"
}
trap restore EXIT

fails=0
# arm NAME GREP FROM TO: replace exactly one occurrence of FROM with TO, run tests matching GREP.
arm() {
  local name=$1 grep=$2 from=$3 to=$4
  cp "$BACKUP" "$APP"
  local n
  n=$(FROM="$from" python3 -c 'import os,sys; print(open(sys.argv[1]).read().count(os.environ["FROM"]))' "$APP")
  if [ "$n" != "1" ]; then echo "ARM $name: pattern found $n times (need 1) -> arm invalid"; fails=$((fails+1)); return; fi
  FROM="$from" TO="$to" python3 -c 'import os,sys; p=sys.argv[1]; s=open(p).read(); open(p,"w").write(s.replace(os.environ["FROM"], os.environ["TO"]))' "$APP"
  local log; log=$(mktemp -t approve-mut)
  bunx playwright test --project=phone -g "$grep" --retries=0 >"$log" 2>&1
  local rc=$?
  if [ $rc -ne 0 ]; then
    echo "ARM $name: RED as required (rc=$rc)"
    grep -E "✘|Error:|Expected|Received" "$log" | head -6 | sed 's/^/    /'
  else
    echo "ARM $name: STILL GREEN -> the test does not guard this property"
    tail -5 "$log" | sed 's/^/    /'
    fails=$((fails+1))
  fi
  rm -f "$log"
}

arm "xss: body via innerHTML" "XSS probe" \
  'setText(bodyEl, str(a.body));' \
  'bodyEl.innerHTML = str(a.body);'

arm "decision binding dropped from auth/options" "list, expand, approve one and deny one" \
  'freshAssertion({ purpose: "decide", request_id: a.request_id, decision })' \
  'freshAssertion({ purpose: "decide", request_id: a.request_id })'

arm "decision binding wrong (always approve)" "list, expand, approve one and deny one" \
  'freshAssertion({ purpose: "decide", request_id: a.request_id, decision })' \
  'freshAssertion({ purpose: "decide", request_id: a.request_id, decision: "approve" })'

arm "frame guard removed" "refuses to run inside a frame" \
  'if (window.top !== window.self) {' \
  'if (false) {'

arm "final error keeps dead buttons" "expired code says so" \
  'if (!errs.show(err, again)) for (const b of buttons) b.hidden = true;' \
  'errs.show(err, again);'

echo "mutation arms failed to go red: $fails"
[ $fails -eq 0 ]
