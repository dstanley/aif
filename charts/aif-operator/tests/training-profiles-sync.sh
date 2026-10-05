#!/usr/bin/env bash
# The chart's default training profiles are a copy of examples/training/profiles: fail if they differ.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
diff -r "$here/../../examples/training/profiles" "$here/files/training-profiles"
echo "training profiles in sync"
