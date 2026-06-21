#!/bin/bash
# Start multiple Go wrapper workers behind local Nginx load balancer.

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

if [ -f ".env" ]; then
    set -a
    source .env
    set +a
fi

if ! command -v go &> /dev/null; then
    echo "❌ Go is not installed. Install from https://golang.org/dl/"
    exit 1
fi

if ! command -v nginx &> /dev/null; then
    echo "❌ nginx is not installed. Install with: brew install nginx"
    exit 1
fi

MONGO_URI="${MONGO_URI:-}"
if [ -z "$MONGO_URI" ]; then
    echo "❌ MONGO_URI environment variable not set"
    echo "Set it in .env or export it before running this script"
    exit 1
fi

MONGO_HOST=$(echo "$MONGO_URI" | sed -E 's#^[a-zA-Z0-9+.-]+://##; s#^[^@]*@##; s#/.*$##; s#\?.*$##')

mkdir -p .pids .logs .nginx/logs
mkdir -p .nginx/tmp/client_body .nginx/tmp/proxy .nginx/tmp/fastcgi .nginx/tmp/uwsgi .nginx/tmp/scgi

echo "📦 Building Go wrapper..."
if [ ! -f "go.sum" ]; then
    go mod tidy
fi
go build -o mongo_wrapper main.go
echo "✅ Go wrapper built"

echo "🚀 Starting wrapper workers on ports 9000, 9001, 9002"
for port in 9000 9001 9002; do
    nohup env MONGO_URI="$MONGO_URI" PORT="$port" DB_NAME="${DB_NAME:-ohcl_data}" ONED_EQ_COLLECTION="${ONED_EQ_COLLECTION:-oned-eq}" HISTORIC_EQ_COLLECTION="${HISTORIC_EQ_COLLECTION:-historic-eq}" DEBUG="${DEBUG:-false}" ./mongo_wrapper > ".logs/wrapper-${port}.log" 2>&1 &
    echo $! > ".pids/wrapper-${port}.pid"
done

echo "🌐 Starting Nginx load balancer on http://localhost:9010"
nginx -p "$DIR/.nginx" -c "$DIR/nginx-workers.conf"

echo ""
echo "✅ Multi-worker setup is running"
echo "   DB_NAME=${DB_NAME:-ohcl_data}"
echo "   MONGO_HOST=${MONGO_HOST:-<unknown>}"
echo "   Workers: 9000, 9001, 9002"
echo "   Load balancer: http://localhost:9010"
echo ""
echo "Run benchmark with:"
echo "  API_BASE_URL=http://localhost:9010 ./run_benchmark.sh"
