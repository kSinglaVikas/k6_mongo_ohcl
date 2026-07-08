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

WORKER_COUNT=${1:-3}
if ! [[ "$WORKER_COUNT" =~ ^[1-9]$ ]]; then
    echo "❌ Invalid worker count: $WORKER_COUNT"
    echo "Usage: ./start_wrapper_workers.sh [1-9]"
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

ports=()
for i in $(seq 0 $((WORKER_COUNT - 1))); do
    ports+=("$((9000 + i))")
done

NGINX_CONFIG_PATH="$DIR/.nginx/nginx-workers.generated.conf"

echo "📦 Building Go wrapper..."
if [ ! -f "go.sum" ]; then
    go mod tidy
fi
go build -o mongo_wrapper main.go
echo "✅ Go wrapper built"

echo "🚀 Starting $WORKER_COUNT wrapper worker(s) on ports: ${ports[*]}"
for port in "${ports[@]}"; do
    nohup env MONGO_URI="$MONGO_URI" PORT="$port" DB_NAME="${DB_NAME:-ohcl_data}" ONED_EQ_COLLECTION="${ONED_EQ_COLLECTION:-oned-eq}" HISTORIC_EQ_COLLECTION="${HISTORIC_EQ_COLLECTION:-historic-eq}" DEBUG="${DEBUG:-false}" ./mongo_wrapper > ".logs/wrapper-${port}.log" 2>&1 &
    echo $! > ".pids/wrapper-${port}.pid"
done

cat > "$NGINX_CONFIG_PATH" <<EOF
worker_processes  1;

pid logs/nginx.pid;
error_log logs/error.log warn;

events {
    worker_connections 1024;
}

http {
    access_log logs/access.log;

    client_body_temp_path tmp/client_body;
    proxy_temp_path tmp/proxy;
    fastcgi_temp_path tmp/fastcgi;
    uwsgi_temp_path tmp/uwsgi;
    scgi_temp_path tmp/scgi;

    upstream wrapper_backend {
EOF

for port in "${ports[@]}"; do
    echo "        server 127.0.0.1:${port};" >> "$NGINX_CONFIG_PATH"
done

cat >> "$NGINX_CONFIG_PATH" <<EOF
        least_conn;
    }

    server {
        listen 9010;
        server_name localhost;

        location / {
            proxy_http_version 1.0;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_pass http://wrapper_backend;
        }
    }
}
EOF

echo "🌐 Starting Nginx load balancer on http://localhost:9010"
nginx -p "$DIR/.nginx" -c "$NGINX_CONFIG_PATH"

echo ""
echo "✅ Multi-worker setup is running"
echo "   DB_NAME=${DB_NAME:-ohcl_data}"
echo "   MONGO_HOST=${MONGO_HOST:-<unknown>}"
echo "   Workers (${WORKER_COUNT}): ${ports[*]}"
echo "   Load balancer: http://localhost:9010"
echo ""
echo "Run benchmark with:"
echo "  API_BASE_URL=http://localhost:9010 ./run_benchmark.sh"
