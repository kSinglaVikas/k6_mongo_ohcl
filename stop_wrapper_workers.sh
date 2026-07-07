#!/bin/bash
# Stop Go wrapper workers and local Nginx load balancer started by start_wrapper_workers.sh.

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "🛑 Stopping wrapper workers..."
for pid_file in .pids/wrapper-*.pid; do
    if [ -f "$pid_file" ]; then
        pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid"
        fi
        rm -f "$pid_file"
    fi
done

echo "🛑 Stopping Nginx load balancer..."
if [ -f ".nginx/logs/nginx.pid" ]; then
    NGINX_CONFIG="$DIR/.nginx/nginx-workers.generated.conf"
    if [ ! -f "$NGINX_CONFIG" ]; then
        NGINX_CONFIG="$DIR/nginx-workers.conf"
    fi
    nginx -p "$DIR/.nginx" -c "$NGINX_CONFIG" -s quit || true
fi

echo "✅ Multi-worker stack stopped"
