#!/bin/bash
# Run only oned-eq-packed find benchmark for multiple RPS values.
#
# Usage:
#   ./run_oned_eq_packed_find_rps_sweep.sh
#   ./run_oned_eq_packed_find_rps_sweep.sh 50 100 200 400 800
#
# Env overrides:
#   API_BASE_URL
#   SWEEP_API_BASE_URL (preferred override for this script)
#   SWEEP_ALLOW_SINGLE_WORKER=1 (allow API_BASE_URL=...:9000)
#   MINUTES (default: 1)
#   PREALLOCATED_VUS (default: 50)
#   MAX_VUS (default: 8000)
#   ONED_EQ_PACKED_COLLECTION (default: oned-eq-packed)

set -e
set -o pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

if [ -f ".env" ]; then
    set -a
    source .env
    set +a
fi

API_BASE_URL=${SWEEP_API_BASE_URL:-${API_BASE_URL:-http://localhost:9010}}
if [ "${SWEEP_ALLOW_SINGLE_WORKER:-0}" != "1" ]; then
    API_BASE_URL="${API_BASE_URL/localhost:9000/localhost:9010}"
    API_BASE_URL="${API_BASE_URL/127.0.0.1:9000/127.0.0.1:9010}"
fi
MINUTES=${MINUTES:-1}
PREALLOCATED_VUS=${PREALLOCATED_VUS:-50}
MAX_VUS=${MAX_VUS:-8000}
ONED_EQ_PACKED_COLLECTION=${ONED_EQ_PACKED_COLLECTION:-oned-eq-packed}

if [ "$#" -gt 0 ]; then
    RPS_VALUES=("$@")
else
    RPS_VALUES=(50 100 200 400 800)
fi

if ! command -v k6 >/dev/null 2>&1; then
    echo "❌ k6 is not installed. Install with: brew install k6"
    exit 1
fi

echo "⏳ Checking if API is running on ${API_BASE_URL}..."
if ! curl -s "${API_BASE_URL}/health" >/dev/null 2>&1; then
    echo "❌ API is not running!"
    echo "Start it first with ./start_wrapper.sh or ./start_wrapper_workers.sh"
    exit 1
fi
echo "✅ API is ready"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUT_DIR=".logs/packed-find-rps-sweep-${TIMESTAMP}"
mkdir -p "$OUT_DIR"

echo ""
echo "📊 Running packed find RPS sweep"
echo "   API_BASE_URL=${API_BASE_URL}"
echo "   MINUTES=${MINUTES}"
echo "   PREALLOCATED_VUS=${PREALLOCATED_VUS}"
echo "   MAX_VUS=${MAX_VUS}"
echo "   ONED_EQ_PACKED_COLLECTION=${ONED_EQ_PACKED_COLLECTION}"
echo "   RPS list: ${RPS_VALUES[*]}"
echo "   Logs: ${OUT_DIR}"
echo ""

for rps in "${RPS_VALUES[@]}"; do
    echo "============================================================"
    echo "▶ Running RPS=${rps} for ${MINUTES} minute(s)"
    LOG_FILE="${OUT_DIR}/rps_${rps}.log"

    if [ "${MAX_VUS}" -lt "${PREALLOCATED_VUS}" ]; then
        MAX_VUS=${PREALLOCATED_VUS}
    fi

    echo "   using PREALLOCATED_VUS=${PREALLOCATED_VUS} MAX_VUS=${MAX_VUS}"

k6 run -q --summary-mode=compact \
      --env API_BASE_URL="${API_BASE_URL}" \
      --env RPS="${rps}" \
      --env MINUTES="${MINUTES}" \
            --env PREALLOCATED_VUS="${PREALLOCATED_VUS}" \
            --env MAX_VUS="${MAX_VUS}" \
      --env ONED_EQ_PACKED_COLLECTION="${ONED_EQ_PACKED_COLLECTION}" \
    benchmarks/benchmark_k6_find_oned_eq_packed.js | tee "${LOG_FILE}"

    echo "✔ Completed RPS=${rps}, log saved to ${LOG_FILE}"
    echo ""
done

echo "✅ Sweep complete. Logs directory: ${OUT_DIR}"
