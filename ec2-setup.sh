#!/bin/bash
# EC2 Setup Script - Install Go, k6, and MongoDB Benchmark Dependencies
# Usage: bash ec2-setup.sh

set -e

echo "================================"
echo "EC2 Setup: Go + k6 + Dependencies"
echo "================================"

# Update system packages
echo "[1/4] Updating system packages..."
sudo yum update -y

# Install Go 1.21+
echo "[2/4] Installing Go..."
GO_VERSION="1.21.0"
cd /tmp

# Download Go
if ! wget -q https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz; then
    echo "ERROR: Failed to download Go ${GO_VERSION}"
    exit 1
fi

# Extract Go
sudo rm -rf /usr/local/go
if ! sudo tar -C /usr/local -xzf go${GO_VERSION}.linux-amd64.tar.gz; then
    echo "ERROR: Failed to extract Go"
    exit 1
fi
rm go${GO_VERSION}.linux-amd64.tar.gz

# Add Go to PATH (in ~/.bashrc and current session)
if ! grep -q "/usr/local/go/bin" ~/.bashrc; then
    echo "export PATH=\$PATH:/usr/local/go/bin:\$HOME/go/bin" >> ~/.bashrc
fi
export PATH=$PATH:/usr/local/go/bin:$HOME/go/bin
hash -r

# Verify Go
if ! /usr/local/go/bin/go version; then
    echo "ERROR: Go installation failed"
    exit 1
fi
echo "✓ Go installed successfully"

# Install k6
echo "[3/4] Installing k6..."
sudo yum install -y https://dl.k6.io/rpm/repo.rpm
sudo yum install -y k6

# Verify k6
k6 version

# Install nginx for multi-worker load balancing setup
echo "[4/4] Installing nginx..."
sudo yum install -y nginx
nginx -v


# Go modules will auto-download when building main.go
echo ""
echo "================================"
echo "✓ Setup Complete!"
echo "================================"
echo ""
echo "IMPORTANT: Go is now in PATH for this session."
echo "For new terminals, either:"
echo "  1. Manually source: source ~/.bashrc"
echo "  2. Or log out and log back in"
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
