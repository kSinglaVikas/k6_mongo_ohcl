# EC2 Setup Guide

This guide provides step-by-step instructions to set up the k6 MongoDB benchmark on AWS EC2.

## Quick Start (Automated)

```bash
bash ec2-setup.sh
```

## Manual Setup (Step-by-Step)

### 1. Update System Packages

```bash
sudo yum update -y
```

### 2. Install Go 1.21+

```bash
GO_VERSION="1.21.0"
cd /tmp
wget https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go${GO_VERSION}.linux-amd64.tar.gz
rm go${GO_VERSION}.linux-amd64.tar.gz

# Add Go to PATH
echo "export PATH=\$PATH:/usr/local/go/bin:\$HOME/go/bin" >> ~/.bashrc
source ~/.bashrc

# Verify
go version
```

### 3. Install k6

```bash
sudo yum install -y https://dl.k6.io/rpm/repo.rpm
sudo yum install -y k6

# Verify
k6 version
```

### 4. Install Git

```bash
sudo yum install -y git
```

### 5. Install curl (for health checks)

```bash
sudo yum install -y curl
```

### 6. Install Nginx (for multi-worker load balancing)

```bash
sudo yum install -y nginx

# Verify
nginx -v
```

### 7. Clone the Repository

```bash
cd ~
git clone <your-repo-url>
cd k6_mongo_ohcl
```

### 8. Build the MongoDB Wrapper

```bash
go build -o mongo_wrapper main.go
```

This automatically downloads:
- `go.mongodb.org/mongo-driver v1.15.0`
- Other required dependencies

### 9. Set MongoDB Connection

```bash
export MONGO_URI="mongodb+srv://username:password@cluster.mongodb.net/?retryWrites=true&w=majority"
```

Or for local MongoDB:
```bash
export MONGO_URI="mongodb://localhost:27017"
```

### 10. Run the Wrapper (Terminal 1)

```bash
PORT=9000 ./mongo_wrapper
```

Expected output:
```
Connection pool config: min=10, max=100
Connected to MongoDB: mongodb+srv://... / ohcl_data (pool: 10-100)
Starting HTTP server on :9000
```

### 11. Run the Benchmark (Terminal 2)

```bash
k6 run \
  --env API_BASE_URL=http://localhost:9000 \
  --env USERS=20 \
  --env MINUTES=2 \
  --env FIND_WAIT_MS=1 \
  --env AGG_WAIT_MS=10 \
  benchmark_k6_http.js
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_URI` | `mongodb://localhost:27017` | MongoDB connection string |
| `DB_NAME` | `ohcl_data` | Database name |
| `FIND_COLLECTION` | `1d_stocks` | Collection for find queries |
| `AGG_COLLECTION` | `7d_stocks` | Collection for aggregation |
| `MIN_POOL_SIZE` | `10` | Min connection pool size |
| `MAX_POOL_SIZE` | `100` | Max connection pool size |
| `PORT` | `8080` | HTTP wrapper listen port |
| `API_BASE_URL` | `http://localhost:9000` | k6 wrapper URL |
| `USERS` | `20` | Virtual users per scenario |
| `MINUTES` | `2` | Duration of each scenario |
| `FIND_WAIT_MS` | `1` | Sleep after each find query (ms) |
| `AGG_WAIT_MS` | `10` | Sleep after each aggregation (ms) |

## Troubleshooting

### Port 9000 Already in Use

```bash
lsof -i :9000
kill -9 <PID>
```

### MongoDB Connection Fails

- Verify MONGO_URI is correct
- Check security groups allow inbound on MongoDB port
- Test connectivity: `nc -zv cluster.mongodb.net 27017`

### k6 Health Check Fails

```bash
curl http://localhost:9000/health
```

Should return: `{"status":"ok"}`

### Low Query Latency Seems Wrong

- Ensure MongoDB wrapper is running (separate terminal)
- Check wrapper logs for errors
- Verify MIN_POOL_SIZE and MAX_POOL_SIZE are appropriate for concurrency level

## Performance Tuning

### Increase Concurrency

```bash
./run_benchmark.sh 100 5 1 10
# USERS=100, MINUTES=5, FIND_WAIT_MS=1, AGG_WAIT_MS=10
```

### Adjust Connection Pool

```bash
MIN_POOL_SIZE=20 MAX_POOL_SIZE=200 PORT=9000 ./mongo_wrapper
```

### Export Results

```bash
k6 run benchmark_k6_http.js --out json=results.json
```

## EC2 Instance Recommendations

- **Type**: `t3.xlarge` or larger for 20+ concurrent users
- **Storage**: `30GB` EBS (gp3 recommended)
- **Security Groups**: 
  - Allow port 9000 (wrapper)
  - Allow port 27017 (MongoDB, if local)
  - SSH port 22
- **VPC**: Same as MongoDB cluster if using Atlas (or allow outbound to Atlas IP)

## Next Steps

See README.md for full documentation and advanced usage.
