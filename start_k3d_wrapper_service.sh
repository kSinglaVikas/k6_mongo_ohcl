#!/bin/bash
# Build wrapper image, deploy 10 pods on k3d, and expose service at localhost:9010.

set -euo pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

if [ -f ".env" ]; then
    set -a
    source .env
    set +a
fi

CLUSTER_NAME=${CLUSTER_NAME:-mongo-wrapper}
NAMESPACE=${NAMESPACE:-benchmark}
REPLICAS=${1:-${REPLICAS:-10}}
IMAGE_NAME=${IMAGE_NAME:-mongo-wrapper:latest}

if ! [[ "$REPLICAS" =~ ^[1-9][0-9]*$ ]]; then
    echo "❌ Invalid replica count: $REPLICAS"
    echo "Usage: ./start_k3d_wrapper_service.sh [replicas]"
    exit 1
fi

if [ -z "${MONGO_URI:-}" ]; then
    echo "❌ MONGO_URI is not set. Put it in .env or export it before running."
    exit 1
fi

for cmd in docker k3d kubectl; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "❌ Required command not found: $cmd"
        exit 1
    fi
done

echo "📦 Building Docker image ${IMAGE_NAME} ..."
docker build -f app/Dockerfile -t "$IMAGE_NAME" app

if ! k3d cluster list | awk '{print $1}' | grep -qx "$CLUSTER_NAME"; then
    echo "🚀 Creating k3d cluster ${CLUSTER_NAME} (maps localhost:9010 -> NodePort 30090) ..."
    k3d cluster create "$CLUSTER_NAME" --servers 1 --agents 2 -p "9010:30090@server:0" --wait
else
    echo "ℹ️ Reusing existing k3d cluster: ${CLUSTER_NAME}"
fi

kubectl config use-context "k3d-${CLUSTER_NAME}" >/dev/null

echo "📥 Importing image into k3d ..."
k3d image import "$IMAGE_NAME" -c "$CLUSTER_NAME"

echo "🧩 Applying Kubernetes manifests ..."
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/wrapper-configmap.yaml
kubectl -n "$NAMESPACE" create secret generic mongo-wrapper-secrets \
    --from-literal=MONGO_URI="$MONGO_URI" \
    --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f deploy/k8s/wrapper-deployment.yaml
kubectl apply -f deploy/k8s/wrapper-service.yaml

kubectl -n "$NAMESPACE" scale deployment mongo-wrapper --replicas "$REPLICAS"
kubectl -n "$NAMESPACE" rollout status deployment/mongo-wrapper --timeout=180s

echo ""
echo "✅ k3d wrapper service is ready"
echo "   Cluster: ${CLUSTER_NAME}"
echo "   Namespace: ${NAMESPACE}"
echo "   Replicas: ${REPLICAS}"
echo "   Endpoint: http://localhost:9010"
echo ""
echo "Run benchmark against service:"
echo "  API_BASE_URL=http://localhost:9010 ./run_benchmark.sh"
