# Quick Start — k6 + Go Wrapper Benchmark

## One-Minute Setup

### Terminal 1: Start the wrapper service

```bash
cd /Users/vikas.k.singla/working/customers/INDMoney/k6_mongo_ohcl

export MONGO_URI="mongodb+srv://user:pass@cluster.mongodb.net/ohcl_data?retryWrites=true"
export DB_NAME="ohcl_data"
export ONED_EQ_COLLECTION="oned-eq"
export HISTORIC_EQ_COLLECTION="historic-eq"
./start_wrapper.sh
```

You should see:

```text
Connected to MongoDB database ohcl_data (pool: 100-200)
Starting HTTP server on :9000
```

### Terminal 2: Run the benchmark

```bash
cd /Users/vikas.k.singla/working/customers/INDMoney/k6_mongo_ohcl

k6 run \
  --env API_BASE_URL=http://localhost:9000 \
  --env TOTAL_RPS=100 \
  --env MINUTES=2 \
  --env RATE_STEP=1 \
  --env RATE_STEP_SECONDS=5 \
  --env PREALLOCATED_VUS=50 \
  --env MAX_VUS=500 \
  benchmark_k6_http.js
```

## Traffic Mix

The script runs 5 scenarios in parallel using weighted request rates:

1. `oned_eq_5m_agg` — 50%
2. `oned_eq_1m_find` — 10%
3. `historic_eq_3d_5m_agg` — 20%
4. `historic_eq_3d_1m_find` — 5%
5. `historic_eq_15_30m_agg` — 15%

With `TOTAL_RPS=100`, target rates become `50/10/20/5/15 req/s`.

## Environment Variables

### Wrapper (`main.go`)

```bash
export MONGO_URI="mongodb://localhost:27017"
export DB_NAME="ohcl_data"
export ONED_EQ_COLLECTION="oned-eq"
export HISTORIC_EQ_COLLECTION="historic-eq"
export PORT="9000"
export DEBUG="false"
```

### k6 (`benchmark_k6_http.js`)

```bash
export API_BASE_URL="http://localhost:9000"
export TOTAL_RPS="100"
export PREALLOCATED_VUS="50"
export MAX_VUS="500"
export RATE_STEP="1"
export RATE_STEP_SECONDS="5"
export MINUTES="2"
export AGG_MIN_TS="2026-05-07T00:00:00Z"
export AGG_MAX_TS="2026-06-02T00:00:00Z"
```

## Troubleshooting

### "API health check failed"

```bash
curl http://localhost:9000/health
```

### Too many dropped iterations / can’t keep target rate

1. Increase `PREALLOCATED_VUS` and/or `MAX_VUS`.
2. Reduce `TOTAL_RPS`.
3. Check MongoDB CPU, memory, and index coverage.

### Query counts are zero

1. Confirm collection names are correct (`ONED_EQ_COLLECTION`, `HISTORIC_EQ_COLLECTION`).
2. Confirm `id` and `ts` fields exist in data.
3. Ensure requested timestamp windows contain data.
