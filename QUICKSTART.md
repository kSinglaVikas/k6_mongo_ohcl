# Quick Start — k6 + Go Wrapper Benchmark

## One-Minute Setup

### Terminal 1: Start the wrapper service

```bash
cd /Users/vikas.k.singla/working/customers/INDMoney/k6_mongo_ohcl

export MONGO_URI="mongodb+srv://user:pass@cluster.mongodb.net/ohcl_data?retryWrites=true"
./start_wrapper.sh
```

You should see:
```
Connected to MongoDB: mongodb+srv://... / ohcl_data
Starting HTTP server on :9000
```

### Terminal 2: Run the benchmark

```bash
cd /Users/vikas.k.singla/working/customers/INDMoney/k6_mongo_ohcl

./run_benchmark.sh [USERS] [MINUTES] [FIND_WAIT_MS] [AGG_WAIT_MS]
```

Default: `./run_benchmark.sh 20 2 1 10` (20 VUs, 2 min **parallel** find+agg, 1ms wait between finds, 10ms between aggs)

Example with custom parameters:
```bash
./run_benchmark.sh 50 5 2 15
```

## Expected Output

The benchmark runs two scenarios **in parallel** for the same duration:

**Parallel execution (0-2min)**:
```
✓ [=====>      ] 50 VUs  1m59s  completed find + agg queries simultaneously
```

Both find queries on 1d_stocks and aggregation queries on 7d_stocks run concurrently.

**Summary** (at the end):
```
     find_latency_ms ........... avg=42.34   p(95)=65.78  p(99)=89.12  max=234.56
     agg_latency_ms ........... avg=128.91  p(95)=159.23 p(99)=187.45 max=512.34
     agg_latency_5m_ms ........ avg=142.56  p(95)=178.45 p(99)=201.67 max=623.89
     agg_latency_15m_ms ....... avg=125.42  p(95)=156.23 p(99)=189.45 max=512.34
     agg_latency_30m_ms ....... avg=118.76  p(95)=142.89 p(99)=171.23 max=398.12
     find_errors ............. 0
     agg_errors .............. 0
     http_errors ............ 0
```

## Files

| File | Purpose |
|---|---|
| `main.go` | Go HTTP wrapper (3 endpoints: /find, /aggregate, /health) |
| `benchmark_k6_http.js` | k6 test script (2 scenarios: find, aggregate) |
| `go.mod` | Go module definition |
| `start_wrapper.sh` | Start the Go wrapper service |
| `run_benchmark.sh` | Run the k6 benchmark |
| `README.md` | Full documentation |

## Environment Variables

**Before starting wrapper (`start_wrapper.sh`):**
```bash
export MONGO_URI="mongodb://localhost:27017"          # MongoDB URI
export DB_NAME="ohcl_data"                             # Database
export FIND_COLLECTION="1d_stocks"                     # Collection for find queries
export AGG_COLLECTION="7d_stocks"                      # Collection for agg queries
export PORT="9000"                                     # HTTP port (default 9000)
```

**Before running k6 (`run_benchmark.sh`):**
```bash
export API_BASE_URL="http://localhost:9000"            # Wrapper URL
export USERS="20"                                      # VUs per scenario
export MINUTES="2"                                     # Duration (both scenarios run in parallel)
export FIND_WAIT_MS="1"                                # Sleep after find (ms)
export AGG_WAIT_MS="10"                                # Sleep after agg (ms)
```

## Troubleshooting

### "Go wrapper is not running!"
```bash
# Make sure Terminal 1 is still running ./start_wrapper.sh
# Check: curl http://localhost:9000/health
```

### "Connection refused" from wrapper
- Check MongoDB URI is correct
- Verify MongoDB is accessible
- Try: `mongosh "$MONGO_URI"`

### High error rates during benchmark
- Reduce `USERS` or increase `FIND_WAIT_MS` / `AGG_WAIT_MS`
- Check MongoDB logs for slow queries
- Monitor server CPU/memory

## Next Steps

1. **Run with different USERS**: `./run_benchmark.sh 5` (baseline) → `./run_benchmark.sh 100` (stress)
2. **Export results**: `k6 run benchmark_k6_http.js --out json=results.json`
3. **Tune MongoDB**: Create indexes based on aggregation $match patterns
4. **Compare results**: Save baseline, make changes, re-run, compare metrics

## Key Differences from Original Python Script

- **Python**: Uses multiprocessing (OS processes), PyMongo driver
- **k6 + Go**: Uses virtual users (async I/O), HTTP communication
- **Measurement**: k6 measures end-to-end including HTTP; Python measures just driver time
- **Benefit**: No complex xk6 build, native k6, easier to extend metrics
