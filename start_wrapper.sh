#!/bin/bash
# Quick-start script for k6 + Go wrapper benchmark

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# Check prerequisites
if ! command -v go &> /dev/null; then
    echo "❌ Go is not installed. Install from https://golang.org/dl/"
    exit 1
fi

if ! command -v k6 &> /dev/null; then
    echo "❌ k6 is not installed. Install with: brew install k6"
    exit 1
fi

# Get MongoDB URI
MONGO_URI="${MONGO_URI:-}"
if [ -z "$MONGO_URI" ]; then
    echo "❌ MONGO_URI environment variable not set"
    echo "Set it with: export MONGO_URI='mongodb+srv://user:pass@cluster/db?retryWrites=true'"
    exit 1
fi

# Parse optional arguments
USERS=${1:-20}
MINUTES=${2:-2}
FIND_WAIT_MS=${3:-1}
AGG_WAIT_MS=${4:-10}

echo "📦 Building Go wrapper..."
if [ ! -f "go.sum" ]; then
    go mod tidy
fi
go build -o mongo_wrapper main.go
echo "✅ Go wrapper built"

echo ""
echo "🚀 Starting Go wrapper service on http://localhost:9000"
echo "   MONGO_URI=$MONGO_URI"
echo "   DB_NAME=${DB_NAME:-ohcl_data}"
echo "   FIND_COLLECTION=${FIND_COLLECTION:-1d_stocks}"
echo "   AGG_COLLECTION=${AGG_COLLECTION:-7d_stocks}"
echo ""
echo "⚠️  To run the benchmark, open a new terminal and run:"
echo "   cd $DIR"
echo "   k6 run benchmark_k6_http.js"
echo ""

# Start the wrapper in the foreground
MONGO_URI="$MONGO_URI" PORT=9000 ./mongo_wrapper
