#!/bin/bash
# Run the k6 benchmark

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

if [ -f ".env" ]; then
    set -a
    source .env
    set +a
fi

API_BASE_URL=${API_BASE_URL:-http://localhost:9000}

# Check that k6 is installed
if ! command -v k6 &> /dev/null; then
    echo "❌ k6 is not installed. Install with: brew install k6"
    exit 1
fi

# Check that the API is running
echo "⏳ Checking if Go wrapper is running on $API_BASE_URL..."
if ! curl -s "$API_BASE_URL/health" > /dev/null 2>&1; then
    echo "❌ Go wrapper is not running!"
    echo "Start it in another terminal with: ./start_wrapper.sh"
    exit 1
fi
echo "✅ Go wrapper is ready"

# Parse arguments
TOTAL_RPS=${1:-${TOTAL_RPS:-100}}
MINUTES=${2:-${MINUTES:-2}}
RATE_STEP=${3:-${RATE_STEP:-1}}
RATE_STEP_SECONDS=${4:-${RATE_STEP_SECONDS:-5}}
PREALLOCATED_VUS=${5:-${PREALLOCATED_VUS:-50}}
MAX_VUS=${6:-${MAX_VUS:-1500}}
AGG_MIN_TS=${7:-${AGG_MIN_TS:-2023-03-20T00:00:00Z}}
AGG_MAX_TS=${8:-${AGG_MAX_TS:-2023-05-05T00:00:00Z}}
FIND_PHASE_RPS=${9:-${FIND_PHASE_RPS:-$TOTAL_RPS}}
AGG_PHASE_RPS=${10:-${AGG_PHASE_RPS:-$TOTAL_RPS}}
HIST_WINDOW_MIN_DAYS=${11:-${HIST_WINDOW_MIN_DAYS:-5}}
HIST_WINDOW_MAX_DAYS=${12:-${HIST_WINDOW_MAX_DAYS:-30}}

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
echo "   FIND_PHASE_RPS=$FIND_PHASE_RPS"
echo "   AGG_PHASE_RPS=$AGG_PHASE_RPS"
echo "   HIST_WINDOW_MIN_DAYS=$HIST_WINDOW_MIN_DAYS"
echo "   HIST_WINDOW_MAX_DAYS=$HIST_WINDOW_MAX_DAYS"
echo ""

k6 run \
    --env API_BASE_URL=$API_BASE_URL \
    --env TOTAL_RPS=$TOTAL_RPS \
    --env MINUTES=$MINUTES \
    --env RATE_STEP=$RATE_STEP \
    --env RATE_STEP_SECONDS=$RATE_STEP_SECONDS \
    --env PREALLOCATED_VUS=$PREALLOCATED_VUS \
    --env MAX_VUS=$MAX_VUS \
    --env AGG_MIN_TS=$AGG_MIN_TS \
    --env AGG_MAX_TS=$AGG_MAX_TS \
    --env FIND_PHASE_RPS=$FIND_PHASE_RPS \
    --env AGG_PHASE_RPS=$AGG_PHASE_RPS \
    --env HIST_WINDOW_MIN_DAYS=$HIST_WINDOW_MIN_DAYS \
    --env HIST_WINDOW_MAX_DAYS=$HIST_WINDOW_MAX_DAYS \
    benchmarks/benchmark_k6_http.js
