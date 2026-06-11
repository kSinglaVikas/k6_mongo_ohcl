#!/bin/bash
# Run the k6 benchmark

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# Check that k6 is installed
if ! command -v k6 &> /dev/null; then
    echo "❌ k6 is not installed. Install with: brew install k6"
    exit 1
fi

# Check that the API is running
echo "⏳ Checking if Go wrapper is running on http://localhost:9000..."
if ! curl -s http://localhost:9000/health > /dev/null 2>&1; then
    echo "❌ Go wrapper is not running!"
    echo "Start it in another terminal with: ./start_wrapper.sh"
    exit 1
fi
echo "✅ Go wrapper is ready"

# Parse arguments
USERS=${1:-20}
MINUTES=${2:-2}
FIND_WAIT_MS=${3:-1}
AGG_WAIT_MS=${4:-10}
AGG_MIN_TS=${5:-2024-01-01T00:00:00Z}
AGG_MAX_TS=${6:-2026-06-11T00:00:00Z}

echo ""
echo "📊 Running k6 benchmark with settings:"
echo "   USERS=$USERS"
echo "   MINUTES=$MINUTES"
echo "   FIND_WAIT_MS=$FIND_WAIT_MS"
echo "   AGG_WAIT_MS=$AGG_WAIT_MS"
echo "   AGG_MIN_TS=$AGG_MIN_TS"
echo "   AGG_MAX_TS=$AGG_MAX_TS"
echo ""

k6 run \
    --env API_BASE_URL=http://localhost:9000 \
    --env USERS=$USERS \
    --env MINUTES=$MINUTES \
    --env FIND_WAIT_MS=$FIND_WAIT_MS \
    --env AGG_WAIT_MS=$AGG_WAIT_MS \
    --env AGG_MIN_TS=$AGG_MIN_TS \
    --env AGG_MAX_TS=$AGG_MAX_TS \
    benchmark_k6_http.js
