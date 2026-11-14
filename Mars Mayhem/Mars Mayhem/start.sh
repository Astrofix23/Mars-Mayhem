#!/usr/bin/env bash
# MARS MAYHEM — local launcher (Linux / macOS)
# Convenience alias: host.py does the real work (free port, no-cache headers, browser).
set -e
cd "$(dirname "$0")"
exec python3 host.py "$@"
