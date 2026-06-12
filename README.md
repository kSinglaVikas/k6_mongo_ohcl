# MongoDB Benchmark: k6 + Go Wrapper

This is a k6 benchmark that mirrors the Python `parallel_query_benchmark_mp.py` script. It uses a Go HTTP wrapper to communicate with MongoDB (avoiding the xk6-mongo build complexity).

## Architecture

- **main.go** — lightweight HTTP service exposing MongoDB operations:
  - `POST /find` — executes a find query, returns duration
  - `POST /aggregate` — executes an aggregation pipeline, returns duration
  - `GET /health` — health check
  
- **benchmark_k6_http.js** — k6 test script running two scenarios:
  1. **find_benchmark** — random find queries over a fixed date window
  2. **agg_benchmark** — random OHLC aggregation with random bin sizes (5/15/30m)

Both scenarios run in parallel for `MINUTES` duration with `USERS` VUs (virtual users).

## Prerequisites

### 1. Install Go (if not already installed)

```bash
brew install go   # macOS
# or download from https://golang.org/dl/
```

### 2. Install k6

```bash
brew install k6   # macOS
# or download from https://k6.io/docs/get-started/installation/
```

### 3. Have MongoDB connection details

- Set `MONGO_URI` environment variable with your connection string
- Example: `mongodb+srv://user:pass@cluster.mongodb.net/db?retryWrites=true`

### 4. Populate MongoDB with stock data, if required

Before running this benchmark, populate collections like `1d_stocks` and `7d_stocks` using the stock data loader scripts from:

- https://github.com/kSinglaVikas/stockticker

Use that repository to ingest data first, then return here to run the k6 benchmark.

## Setup & Run

### Terminal 1: Start the Go wrapper service

```bash
cd k6_mongo_ohcl

# Download Go dependencies
go mod download

# Build the wrapper
go build -o mongo_wrapper main.go

# Run it
MONGO_URI="mongodb+srv://user:pass@cluster.mongodb.net/ohcl_data?retryWrites=true" \
PORT=9000 \
DB_NAME=ohcl_data \
FIND_COLLECTION=1d_stocks \
AGG_COLLECTION=7d_stocks \
./mongo_wrapper

# Output: "Connected to MongoDB: ... / ohcl_data"
# Then: "Starting HTTP server on :9000"
```

The service will listen on `http://localhost:9000`.

### Terminal 2: Run the k6 benchmark

```bash
cd k6_mongo_ohcl

# Basic run (20 VUs, 2 minutes each scenario)
k6 run benchmark_k6_http.js

# Or customize with env vars:
k6 run \
  --env API_BASE_URL=http://localhost:9000 \
  --env USERS=50 \
  --env MINUTES=5 \
  --env FIND_WAIT_MS=1 \
  --env AGG_WAIT_MS=10 \
  benchmark_k6_http.js
```

## Environment Variables

### Go Wrapper (`main.go`)

| Variable | Default | Description |
|---|---|---|
| `MONGO_URI` | `mongodb://localhost:27017` | MongoDB connection string |
| `DB_NAME` | `ohcl_data` | Database name |
| `FIND_COLLECTION` | `1d_stocks` | Collection for find queries |
| `AGG_COLLECTION` | `7d_stocks` | Collection for aggregation |
| `PORT` | `9000` | HTTP listen port |

### k6 Test Script (`benchmark_k6_http.js`)

| Variable | Default | Description |
|---|---|---|
| `API_BASE_URL` | `http://localhost:9000` | Go wrapper service URL |
| `USERS` | `20` | Virtual users per scenario |
| `MINUTES` | `2` | Duration of each scenario (find, then agg) |
| `FIND_WAIT_MS` | `1` | Sleep after each find query (ms) |
| `AGG_WAIT_MS` | `10` | Sleep after each agg query (ms) |
| `AGG_MIN_TS` | `2024-01-01T00:00:00Z` | Min timestamp for agg window |
| `AGG_MAX_TS` | `2026-06-11T00:00:00Z` | Max timestamp for agg window |

## Metrics

k6 will report:

- `find_latency_ms` — overall find query latencies (p50, p95, p99, etc.)
- `agg_latency_ms` — overall aggregation latencies
- `agg_latency_5m_ms` — aggregation latencies for 5-minute bins
- `agg_latency_15m_ms` — aggregation latencies for 15-minute bins
- `agg_latency_30m_ms` — aggregation latencies for 30-minute bins
- `find_errors` — count of failed find queries
- `agg_errors` — count of failed aggregation queries
- `http_errors` — count of HTTP communication errors

## Example Run Output

```
Checking if Go wrapper is running on http://localhost:9000...
Go wrapper is ready

Running k6 benchmark with settings:
  USERS=60
  MINUTES=15
  FIND_WAIT_MS=20
  AGG_WAIT_MS=100
  AGG_MIN_TS=2024-01-01T00:00:00Z
  AGG_MAX_TS=2026-06-11T00:00:00Z

execution: local
script: benchmark_k6_http.js
output: -

scenarios: (100.00%) 2 scenarios, 120 max VUs, 15m30s max duration (incl. graceful stop):
  * agg_benchmark: 60 looping VUs for 15m0s (exec: aggScenario, gracefulStop: 30s)
  * find_benchmark: 60 looping VUs for 15m0s (exec: findScenario, gracefulStop: 30s)

INFO[0000] API health check passed source=console

TOTAL RESULTS
CUSTOM
  agg_latency_15m_ms.............: avg=1.67ms min=1.08ms med=1.63ms max=46.64ms p(90)=2.05ms p(95)=2.29ms p(99)=3.04ms
  agg_latency_30m_ms.............: avg=1.67ms min=1.07ms med=1.63ms max=40.4ms  p(90)=2.05ms p(95)=2.29ms p(99)=3.05ms
  agg_latency_5m_ms..............: avg=1.67ms min=1.07ms med=1.63ms max=36.62ms p(90)=2.05ms p(95)=2.3ms  p(99)=3.06ms
  agg_latency_ms.................: avg=1.67ms min=1.07ms med=1.63ms max=46.64ms p(90)=2.05ms p(95)=2.3ms  p(99)=3.05ms
  find_latency_ms................: avg=988.89us min=506.35us med=940.29us max=48.57ms p(90)=1.32ms p(95)=1.51ms p(99)=2.1ms

HTTP
  http_req_duration..............: avg=1.65ms min=383.1us med=1.48ms max=48.81ms p(90)=2.48ms p(95)=2.96ms p(99)=4.26ms
  http_req_failed................: 0.00% 0 out of 2974168
  http_reqs......................: 2974168 3304.274277/s

EXECUTION
  iteration_duration.............: avg=36.29ms min=20.75ms med=22.02ms max=147.21ms p(90)=102.43ms p(95)=102.97ms p(99)=104.26ms
  iterations.....................: 2974167 3304.273166/s
  vus............................: 120 min=120 max=120
  vus_max........................: 120 min=120 max=120

NETWORK
  data_received..................: 433 MB 481 kB/s
  data_sent......................: 878 MB 976 kB/s

running (15m00.1s), 000/120 VUs, 2974167 complete and 0 interrupted iterations
agg_benchmark  [======================================] 60 VUs 15m0s
find_benchmark [======================================] 60 VUs 15m0s
```

## Troubleshooting

### "API health check failed"
- Ensure the Go wrapper is running and listening on the correct port
- Check: `curl http://localhost:9000/health`

### "Connection refused"
- Check MongoDB connection string: `MONGO_URI`
- Verify MongoDB server is running and accessible
- Check network connectivity and firewall rules

### High error counts
- Check wrapper logs for detailed errors
- Verify MongoDB has sufficient resources (CPU, memory, connections)
- Reduce `USERS` or increase `FIND_WAIT_MS` / `AGG_WAIT_MS` to lower load

## Comparison to Original Python Script

| Aspect | Python | k6 + Go |
|---|---|---|
| Execution model | Multiprocessing | Virtual Users (async) |
| Per-worker init | One client per process | Shared HTTP pool |
| Query measurement | Client-side (`perf_counter`) | Go wrapper measures + k6 HTTP time |
| Output | Custom tables | k6 standard metrics (JSON exportable) |
| Extensibility | Easy to modify | k6 script is simpler, wrapper handles logic |

Both measure **query latency** from the client's perspective. The k6 version adds HTTP overhead, so absolute latencies will be slightly higher—use the **relative differences** for optimization comparisons.

## Next Steps

1. Run the benchmark with various `USERS` and `MINUTES` to understand throughput limits
2. Export results: `k6 run --out json=results.json benchmark_k6_http.js`
3. Tune MongoDB indexes based on `$match` patterns in the aggregation pipeline
4. Monitor MongoDB logs for slow queries: enable slow query profiling at 100ms threshold
