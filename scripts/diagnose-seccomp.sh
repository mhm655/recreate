#!/usr/bin/env bash
# Pinpoints why node fails to start under the sandbox's security flags.
# Starts node (and one worker thread) under a matrix of runtime x seccomp variants
# and prints which combinations work. Run from the repository root on a Linux
# host with the image built (npm run image).
set -uo pipefail

IMAGE=${IMAGE:-ts-sandbox-harness:latest}
PROFILE=docker/seccomp.json
TMP=$(mktemp -d)

# Relaxed variants of the profile, each changing exactly one rule.
jq '(.syscalls[] | select(.names == ["clone"])) |= del(.args)' "$PROFILE" > "$TMP/clone-unconditional.json"
jq '(.syscalls[] | select(.names == ["clone3"])) |= (.action = "SCMP_ACT_ALLOW" | del(.errnoRet))' "$PROFILE" > "$TMP/clone3-allowed.json"
jq '(.syscalls[] | select(.names == ["clone"])) |= del(.args)
    | (.syscalls[] | select(.names == ["clone3"])) |= (.action = "SCMP_ACT_ALLOW" | del(.errnoRet))' "$PROFILE" > "$TMP/both-relaxed.json"
jq '.defaultAction = "SCMP_ACT_ALLOW"' "$PROFILE" > "$TMP/default-allow.json"

PROBE='const {Worker}=require("worker_threads");const w=new Worker("require(\"worker_threads\").parentPort.postMessage(1)",{eval:true});w.on("message",()=>{console.log("NODE+WORKER OK");process.exit(0)});w.on("error",e=>{console.log("WORKER ERROR "+e.message);process.exit(3)})'

FLAGS=(--network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m
       --memory 256m --memory-swap 256m --cpus 1 --pids-limit 128 --user 10001:10001
       --cap-drop ALL --security-opt no-new-privileges --ulimit nofile=256:256)

try() {
  local label=$1; shift
  local out code
  out=$(timeout 60 docker run --rm "$@" --entrypoint node "$IMAGE" -e "$PROBE" 2>&1); code=$?
  printf '%-58s exit=%-4s %s\n' "$label" "$code" "$(echo "$out" | grep -m1 -E 'OK|ERROR|Assertion|Error|error' | cut -c1-110)"
}

echo "runsc: $(runsc --version 2>/dev/null | head -1)"
echo "runtimes: $(docker info --format '{{json .Runtimes}}' | jq -c 'with_entries(.value |= (.runtimeArgs // []))')"
echo

for rt in runc runsc; do
  try "$rt  bare"                               --runtime "$rt"
  try "$rt  prod flags, seccomp=unconfined"     --runtime "$rt" "${FLAGS[@]}" --security-opt seccomp=unconfined
  try "$rt  prod flags, docker default seccomp" --runtime "$rt" "${FLAGS[@]}"
  try "$rt  prod flags, OUR PROFILE"            --runtime "$rt" "${FLAGS[@]}" --security-opt "seccomp=$PROFILE"
  try "$rt  prod flags, profile: clone unconditional" --runtime "$rt" "${FLAGS[@]}" --security-opt "seccomp=$TMP/clone-unconditional.json"
  try "$rt  prod flags, profile: clone3 allowed"      --runtime "$rt" "${FLAGS[@]}" --security-opt "seccomp=$TMP/clone3-allowed.json"
  try "$rt  prod flags, profile: both relaxed"        --runtime "$rt" "${FLAGS[@]}" --security-opt "seccomp=$TMP/both-relaxed.json"
  try "$rt  prod flags, profile: defaultAction ALLOW" --runtime "$rt" "${FLAGS[@]}" --security-opt "seccomp=$TMP/default-allow.json"
  echo
done
