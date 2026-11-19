#!/bin/bash
# Queue each PR once quality+integration pass and it isn't DIRTY; report required fails once per head.
cd /home/hein/Workspace/CredaFlow
left="$*"; declare -A seen
for i in $(seq 1 300); do
  next=""
  for p in $left; do
    st=$(gh pr view $p --json mergeStateStatus,headRefOid --jq '.mergeStateStatus+" "+.headRefOid[0:8]' 2>/dev/null)
    ms=${st% *}; sha=${st#* }
    c=$(gh pr checks $p 2>/dev/null | grep -P '^(quality|integration)\t')
    n=$(echo "$c" | grep -c .); pend=$(echo "$c" | grep -cP '\t(pending|queued|in_progress)\t'); fail=$(echo "$c" | grep -cP '\tfail\t')
    if [ "$ms" = DIRTY ] || [ "$n" -lt 2 ] || [ "$pend" != 0 ]; then next="$next $p"
    elif [ "$fail" != 0 ]; then
      [ -z "${seen[$p$sha]}" ] && echo "$(date +%H:%M) #$p@$sha REQUIRED FAIL" && seen[$p$sha]=1; next="$next $p"
    else echo "$(date +%H:%M) #$p@$sha $(mq add $p 2>&1 | tail -1)"; fi
  done
  left="$next"; [ -z "$left" ] && break; sleep 90
done; echo "left:$left"
