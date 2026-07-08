# EC2 Setup Guide (Docker + k3d + k6)

This guide sets up the benchmark stack on EC2 with:

- Docker
- k3d (local k3s in Docker)
- kubectl
- k6
- 10 wrapper containers exposed as one service at http://localhost:9010

## 1. Install Base Tools

```bash
sudo yum update -y
sudo yum install -y git curl tar gzip
```

## 2. Install Docker

```bash
sudo yum install -y docker
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker $USER
```

Log out and log back in once so docker group permissions apply.

Verify:

```bash
docker version
```

## 3. Install kubectl

```bash
KUBECTL_VERSION=$(curl -L -s https://dl.k8s.io/release/stable.txt)
curl -LO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
chmod +x kubectl
sudo mv kubectl /usr/local/bin/kubectl

kubectl version --client
```

## 4. Install k3d

```bash
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
k3d version
```

## 5. Install k6

```bash
sudo yum install -y https://dl.k6.io/rpm/repo.rpm
sudo yum install -y k6
k6 version
```

## 6. Clone Repository

```bash
cd ~
git clone <your-repo-url>
cd k6_mongo_ohcl
```

## 7. Configure MongoDB URI

Set in shell:

```bash
export MONGO_URI="mongodb+srv://username:password@cluster.mongodb.net/?retryWrites=true&w=majority"
```

Or store in .env:

```bash
echo 'MONGO_URI="mongodb+srv://username:password@cluster.mongodb.net/?retryWrites=true&w=majority"' >> .env
```

## 8. Start 10 Wrapper Containers on k3d

This script will:

- build app image from app/Dockerfile
- create k3d cluster (if needed)
- import image into k3d
- deploy Kubernetes manifests
- run 10 pods
- expose service on localhost:9010

```bash
./start_k3d_wrapper_service.sh 10
```

Check status:

```bash
kubectl -n benchmark get pods -o wide
kubectl -n benchmark get svc mongo-wrapper
curl http://localhost:9010/health
```

## 9. Run Benchmark Against Service

```bash
API_BASE_URL=http://localhost:9010 ./run_benchmark.sh
```

Or packed-find sweep:

```bash
./run_oned_eq_packed_find_rps_sweep.sh 1000
```

## 10. Stop Stack

Remove workload only:

```bash
./stop_k3d_wrapper_service.sh
```

Remove workload and delete cluster:

```bash
DESTROY_CLUSTER=1 ./stop_k3d_wrapper_service.sh
```

## Files Added for Containerized Deployment

- app/Dockerfile
- deploy/k8s/namespace.yaml
- deploy/k8s/wrapper-configmap.yaml
- deploy/k8s/wrapper-deployment.yaml
- deploy/k8s/wrapper-service.yaml
- start_k3d_wrapper_service.sh
- stop_k3d_wrapper_service.sh

## Troubleshooting

### Service not reachable

```bash
kubectl -n benchmark get pods
kubectl -n benchmark get svc mongo-wrapper
k3d cluster list
curl http://localhost:9010/health
```

### MongoDB connection errors in pods

```bash
kubectl -n benchmark logs deploy/mongo-wrapper --tail=200
kubectl -n benchmark get secret mongo-wrapper-secrets -o yaml
```

Recreate secret with current URI:

```bash
kubectl -n benchmark create secret generic mongo-wrapper-secrets \
  --from-literal=MONGO_URI="$MONGO_URI" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n benchmark rollout restart deployment/mongo-wrapper
```

### Need different replica count

```bash
./start_k3d_wrapper_service.sh 20
```

or

```bash
kubectl -n benchmark scale deployment/mongo-wrapper --replicas=20
```
