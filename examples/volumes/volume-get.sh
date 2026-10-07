#!/usr/bin/env bash
# Copy a file or a folder off a volume (a PersistentVolumeClaim), however large.
#
# A volume can only be read from a pod that mounts it. This starts a short-lived pod that mounts the
# volume read-only, streams the file (or a tar of the folder) out of it with kubectl exec, checks the
# copy, and deletes the pod, also when interrupted. The Python SDK does the same with the rights of
# AI Job Submitter (a Job's pod rather than a bare pod): rancher-ai -p <namespace> volumes get
# <volume> <path> [dest], or ai.volumes.get() in a notebook. This script needs kubectl and the right
# to create pods and exec into them in the namespace.
#
#   volume-get.sh [-n NAMESPACE] [--context CONTEXT] [--kubeconfig FILE] VOLUME PATH [DEST]
#
#   VOLUME  the PersistentVolumeClaim, e.g. dev-dl-lora-1-eval-taught-0-8ftvm-scratch
#   PATH    the file or folder on the volume, from its root, e.g. hf/hub/models--Qwen--Qwen2.5-1.5B-Instruct
#   DEST    where to put it (default: the current folder); a folder keeps the name it has on the volume
#
# The copy is checked against the size on the volume, and a file whose name is a SHA-256 (a Hugging
# Face blob) against that hash. The volume must not be mounted by a running pod on another node
# (most volumes attach to one node at a time). VOLUME_GET_IMAGE overrides the image, which needs
# sh, cat, tar and stat.
set -euo pipefail

IMAGE="${VOLUME_GET_IMAGE:-registry.suse.com/bci/bci-busybox:15.7}"
NS=""
KUBECTL=(kubectl)

usage() { sed -n '11,15p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }
die() { echo "volume-get: $*" >&2; exit 1; }

ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--namespace) NS="$2"; shift 2 ;;
    --context) KUBECTL+=(--context "$2"); shift 2 ;;
    --kubeconfig) KUBECTL+=(--kubeconfig "$2"); shift 2 ;;
    -h|--help) usage 0 ;;
    -*) die "unknown option $1" ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
[ ${#ARGS[@]} -ge 2 ] && [ ${#ARGS[@]} -le 3 ] || usage
CLAIM="${ARGS[0]}"
SRC="${ARGS[1]#/}"
DEST="${ARGS[2]:-.}"
case "/$SRC/" in */../*) die "PATH cannot leave the volume" ;; esac
[ -n "$NS" ] || NS="$("${KUBECTL[@]}" config view --minify -o jsonpath='{..namespace}' 2>/dev/null || true)"
NS="${NS:-default}"
K=("${KUBECTL[@]}" -n "$NS")

"${K[@]}" get pvc "$CLAIM" >/dev/null 2>&1 || die "no volume $CLAIM in $NS"

# od reads a fixed number of bytes: no reader closes early, so pipefail has nothing to trip on
POD="volume-get-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
cleanup() { "${K[@]}" delete pod "$POD" --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

echo "Mounting ${CLAIM} read-only in pod ${POD} (${NS})…"
"${K[@]}" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $POD
  labels: { app.kubernetes.io/name: volume-get }
spec:
  restartPolicy: Never
  terminationGracePeriodSeconds: 1
  containers:
    - name: get
      image: $IMAGE
      command: ["sleep", "3600"]
      resources: { requests: { cpu: 50m, memory: 32Mi }, limits: { memory: 128Mi } }
      volumeMounts: [{ name: data, mountPath: /data, readOnly: true }]
  volumes:
    - name: data
      persistentVolumeClaim: { claimName: $CLAIM, readOnly: true }
EOF

if ! "${K[@]}" wait --for=condition=Ready "pod/$POD" --timeout=180s >/dev/null 2>&1; then
  why="$("${K[@]}" get events --field-selector "involvedObject.name=$POD" -o jsonpath='{range .items[*]}{.reason}: {.message}{"\n"}{end}' 2>/dev/null | tail -3)"
  die "the pod did not start; is $CLAIM mounted by a running pod elsewhere?
$why"
fi

remote() { "${K[@]}" exec "$POD" -- sh -c "$1"; }
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
P="/data/$SRC"
KIND="$(remote "if [ -d $(q "$P") ]; then echo dir; elif [ -f $(q "$P") ]; then echo file; else echo none; fi")"

case "$KIND" in
  none) die "$SRC is not on $CLAIM" ;;
  file)
    SIZE="$(remote "stat -c %s $(q "$P")")"
    [ -d "$DEST" ] && OUT="$DEST/$(basename "$SRC")" || OUT="$DEST"
    echo "Copying $SRC ($SIZE bytes) to ${OUT}…"
    "${K[@]}" exec "$POD" -- cat "$P" > "$OUT.part"
    GOT="$(wc -c < "$OUT.part" | tr -d ' ')"
    [ "$GOT" = "$SIZE" ] || { rm -f "$OUT.part"; die "copy incomplete: $GOT of $SIZE bytes"; }
    NAME="$(basename "$SRC")"
    if printf '%s' "$NAME" | grep -Eq '^[0-9a-f]{64}$'; then
      SUM="$( (command -v sha256sum >/dev/null && sha256sum "$OUT.part" || shasum -a 256 "$OUT.part") | cut -d' ' -f1)"
      [ "$SUM" = "$NAME" ] || { rm -f "$OUT.part"; die "checksum mismatch: got $SUM"; }
      echo "SHA-256 matches the blob's name."
    fi
    mv "$OUT.part" "$OUT"
    echo "Done: $OUT"
    ;;
  dir)
    # -L and tar -h: symlinks are copied as the files they point to (a Hugging Face snapshot is links to its blobs)
    COUNT="$(remote "find -L $(q "$P") -type f | wc -l" | tr -d ' ')"
    mkdir -p "$DEST"
    echo "Copying folder ${SRC} (${COUNT} files) into ${DEST}/…"
    "${K[@]}" exec "$POD" -- tar -C "$(dirname "$P")" -chf - "$(basename "$P")" | tar -xf - -C "$DEST"
    GOT="$(find -L "$DEST/$(basename "$P")" -type f | wc -l | tr -d ' ')"
    [ "$GOT" -ge "$COUNT" ] || die "copy incomplete: $GOT of $COUNT files"
    echo "Done: $DEST/$(basename "$P") ($GOT files)"
    ;;
esac
