#!/bin/bash
# Tear down k3d-deployed wrapper workload. Set DESTROY_CLUSTER=1 to delete cluster.

set -euo pipefail

CLUSTER_NAME=${CLUSTER_NAME:-mongo-wrapper}
NAMESPACE=${NAMESPACE:-benchmark}
DESTROY_CLUSTER=${DESTROY_CLUSTER:-0}

if ! command -v kubectl >/dev/null 2>&1; then
    echo "❌ kubectl is required"
    exit 1
fi

if ! command -v k3d >/dev/null 2>&1; then
    echo "❌ k3d is required"
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "❌ docker is required"
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "❌ Docker daemon is not accessible for the current user."
    echo "   Fix: sudo usermod -aG docker $USER"
    echo "   Then log out/login (or run: newgrp docker) and retry."
    exit 1
fi

if k3d cluster list | awk '{print $1}' | grep -qx "$CLUSTER_NAME"; then
    kubectl config use-context "k3d-${CLUSTER_NAME}" >/dev/null || true

    echo "🛑 Removing wrapper deployment and service from namespace ${NAMESPACE} ..."
    kubectl -n "$NAMESPACE" delete deployment mongo-wrapper --ignore-not-found=true
    kubectl -n "$NAMESPACE" delete service mongo-wrapper --ignore-not-found=true
    kubectl -n "$NAMESPACE" delete configmap mongo-wrapper-config --ignore-not-found=true
    kubectl -n "$NAMESPACE" delete secret mongo-wrapper-secrets --ignore-not-found=true

    if [ "$DESTROY_CLUSTER" = "1" ]; then
        echo "🛑 Deleting k3d cluster ${CLUSTER_NAME} ..."
        k3d cluster delete "$CLUSTER_NAME"
    fi

    echo "✅ k3d wrapper stack stopped"
else
    echo "ℹ️ k3d cluster ${CLUSTER_NAME} not found"
fi
