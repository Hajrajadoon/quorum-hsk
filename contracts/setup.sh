#!/usr/bin/env bash
# One-time setup for the contracts. Needs Foundry: https://book.getfoundry.sh/getting-started/installation
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d lib/forge-std ]; then
  git init -q 2>/dev/null || true
  forge install foundry-rs/forge-std --no-git 2>/dev/null || forge install foundry-rs/forge-std
fi
forge build
forge test -vv
