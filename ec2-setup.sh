#!/bin/bash
# EC2 Setup Script - Install Go, k6, and MongoDB Benchmark Dependencies
# Usage: bash ec2-setup.sh

set -e

echo "================================"
echo "EC2 Setup: Go + k6 + Dependencies"
echo "================================"

# Update system packages
echo "[1/5] Updating system packages..."
sudo yum update -y

# Install Go 1.21+
echo "[2/5] Installing Go..."
GO_VERSION="1.21.0"
cd /tmp
wget -q https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go${GO_VERSION}.linux-amd64.tar.gz
rm go${GO_VERSION}.linux-amd64.tar.gz

# Add Go to PATH
echo "export PATH=\$PATH:/usr/local/go/bin:\$HOME/go/bin" >> ~/.bashrc
source ~/.bashrc

# Verify Go
go version

# Install k6
echo "[3/5] Installing k6..."
sudo yum install -y https://dl.k6.io/rpm/repo.rpm
sudo yum install -y k6

# Verify k6
k6 version

# Install Git (usually pre-installed, but ensure)
echo "[4/5] Installing Git..."
sudo yum install -y git

# Install curl for health checks
echo "[5/5] Installing curl..."
sudo yum install -y curl

# Go modules will auto-download when building main.go
echo ""
echo "================================"
echo "✓ Setup Complete!"
echo "================================"
echo ""
echo "Next steps:"
echo "1. Clone the repository (if not already done):"
echo "   git clone <repo-url>"
echo ""
echo "2. Build the MongoDB wrapper:"
echo "   cd k6_mongo_ohcl"
echo "   go build -o mongo_wrapper main.go"
echo ""
echo "3. Set MongoDB connection string:"
echo "   export MONGO_URI=\"mongodb+srv://user:pass@cluster.mongodb.net/\""
echo ""
echo "4. Start the wrapper (Terminal 1):"
echo "   PORT=9000 ./mongo_wrapper"
echo ""
echo "5. Run the benchmark (Terminal 2):"
echo "   k6 run --env API_BASE_URL=http://localhost:9000 --env USERS=20 --env MINUTES=2 benchmark_k6_http.js"
echo ""
