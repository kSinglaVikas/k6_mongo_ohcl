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
TOTAL_RPS=${1:-400}
MINUTES=${2:-2}
RATE_STEP=${3:-1}
RATE_STEP_SECONDS=${4:-5}
PREALLOCATED_VUS=${5:-50}
MAX_VUS=${6:-500}
AGG_MIN_TS=${7:-2026-05-07T00:00:00Z}
AGG_MAX_TS=${8:-2026-06-02T00:00:00Z}

echo ""
echo "📊 Running k6 benchmark with settings:"
echo "   TOTAL_RPS=$TOTAL_RPS"
echo "   MINUTES=$MINUTES"
echo "   RATE_STEP=$RATE_STEP"
echo "   RATE_STEP_SECONDS=$RATE_STEP_SECONDS"
echo "   PREALLOCATED_VUS=$PREALLOCATED_VUS"
echo "   MAX_VUS=$MAX_VUS"
echo "   AGG_MIN_TS=$AGG_MIN_TS"
echo "   AGG_MAX_TS=$AGG_MAX_TS"
echo ""

k6 run \
    --env API_BASE_URL=http://localhost:9000 \
    --env TOTAL_RPS=$TOTAL_RPS \
    --env MINUTES=$MINUTES \
    --env RATE_STEP=$RATE_STEP \
    --env RATE_STEP_SECONDS=$RATE_STEP_SECONDS \
    --env PREALLOCATED_VUS=$PREALLOCATED_VUS \
    --env MAX_VUS=$MAX_VUS \
    --env AGG_MIN_TS=$AGG_MIN_TS \
    --env AGG_MAX_TS=$AGG_MAX_TS \
    benchmark_k6_http.js
