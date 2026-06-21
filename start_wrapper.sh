#!/bin/bash
# Quick-start script for k6 + Go wrapper benchmark

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

if [ -f ".env" ]; then
    set -a
    source .env
    set +a
fi

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

# Show target host without exposing credentials from the URI.
MONGO_HOST=$(echo "$MONGO_URI" | sed -E 's#^[a-zA-Z0-9+.-]+://##; s#^[^@]*@##; s#/.*$##; s#\?.*$##')

echo "📦 Building Go wrapper..."
if [ ! -f "go.sum" ]; then
    go mod tidy
fi
go build -o mongo_wrapper main.go
echo "✅ Go wrapper built"

echo ""
echo "🚀 Starting Go wrapper service on http://localhost:9000"
echo "   DB_NAME=${DB_NAME:-ohcl_data}"
echo "   MONGO_HOST=${MONGO_HOST:-<unknown>}"
echo ""
echo "⚠️  To run the benchmark, open a new terminal and run:"
echo "   cd $DIR"
echo "   k6 run benchmark_k6_http.js"
echo ""

# Start the wrapper in the foreground
MONGO_URI="$MONGO_URI" PORT="${PORT:-9000}" ./mongo_wrapper
