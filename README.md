# MongoDB Benchmark: k6 + Go Wrapper

This benchmark uses k6 plus a Go HTTP wrapper for MongoDB queries.

## Architecture

- `main.go`
  - `POST /find`
  - `POST /aggregate`
  - `GET /health`
- `benchmark_k6_http.js`
  - 6 weighted scenarios using `ramping-arrival-rate`

## Current Scenario Set

1. `oned_eq_1m_find` — find 1-minute candles for one EQ ID in `oned-eq`
2. `oned_eq_5m_agg` — aggregate 5-minute OHLC candles in `oned-eq`
3. `historic_eq_3d_5m_agg` — aggregate 3 days into 5-minute OHLC in `historic-eq`
4. `historic_eq_3d_1m_find` — find 3 days of 1-minute candles in `historic-eq`
5. `historic_eq_15_30m_agg` — aggregate `historic-eq` into random 15/30-minute OHLC bins
6. `oned_fno_1m_find` — find 1-minute candles for one F&O ID in `oned-fno` (date: 2026-06-02)

## Traffic Distribution

Traffic is distributed by request rate:

- `oned_eq_5m_agg`: 50%
- `oned_eq_1m_find`: 70%
- `historic_eq_3d_5m_agg`: 20%
- `historic_eq_3d_1m_find`: 30%
- `historic_eq_15_30m_agg`: 30%
- `oned_fno_1m_find`: 20%

> Percentages are relative to `TOTAL_RPS` per scenario (scenarios run in two phases, not all summing to 100%).

Rates are derived from `TOTAL_RPS`.

## Setup

### 1. Generate symbols.csv

Fetch the top symbols by document count from all three collections into separate CSV files:

```bash
cd k6_mongo_ohcl

source .env

# Pull top 400 from oned-eq
mongosh "$MONGO_URI" --quiet --eval '
  db.getSiblingDB("charts").getCollection("oned-eq").aggregate([
    { $group: { _id: "$id", cnt: { $count: {} } } },
    { $sort: { cnt: -1 } },
    { $limit: 400 },
    { $project: { cnt: 0 } }
  ]).toArray().map(d => d._id).join("\n")
' > symbols_eq.csv

# Pull top 400 from historic-eq
mongosh "$MONGO_URI" --quiet --eval '
  db.getSiblingDB("charts").getCollection("historic-eq").aggregate([
    { $match: { ts: { $gte: new Date("2023-03-20T00:00:00Z"), $lt: new Date("2026-03-30T00:00:00Z") } } },
    { $group: { _id: "$id", cnt: { $count: {} } } },
    { $sort: { cnt: -1 } },
    { $limit: 400 },
    { $project: { cnt: 0 } }
  ]).toArray().map(d => d._id).join("\n")
' > symbols_historic.csv

# Pull top 400 from oned-fno
mongosh "$MONGO_URI" --quiet --eval '
  db.getSiblingDB("charts").getCollection("oned-fno").aggregate([
    { $match: { ts: { $gte: new Date("2026-06-02T03:00:00Z"), 
                      $lte: new Date("2026-06-02T10:00:00Z") } } },
    { $group: { _id: "$id", cnt: { $count: {} } } },
    { $sort: { cnt: -1 } },
    { $limit: 400 },
    { $project: { cnt: 0 } }
  ]).toArray().map(d => d._id).join("\n")
' > symbols_fno.csv
```

### 2. Start wrapper

```bash
cd k6_mongo_ohcl

go mod download
go build -o mongo_wrapper main.go

MONGO_URI="mongodb+srv://user:pass@cluster.mongodb.net/ohcl_data?retryWrites=true" \
PORT=9000 \
DB_NAME=ohcl_data \
ONED_EQ_COLLECTION=oned-eq \
HISTORIC_EQ_COLLECTION=historic-eq \
DEBUG=false \
./mongo_wrapper
```

### 2b. Start multi-worker wrapper (Gunicorn-like)

This starts three Go wrapper workers on ports `9000-9002` and an Nginx load balancer on `9010`.

```bash
cd k6_mongo_ohcl

./start_wrapper_workers.sh
```

Stop everything:

```bash
cd k6_mongo_ohcl

./stop_wrapper_workers.sh
```

### 3. Run benchmark

```bash
cd k6_mongo_ohcl

k6 run \
  --env API_BASE_URL=http://localhost:9000 \
  --env TOTAL_RPS=100 \
  --env PREALLOCATED_VUS=50 \
  --env MAX_VUS=500 \
  --env RATE_STEP=1 \
  --env RATE_STEP_SECONDS=5 \
  --env MINUTES=2 \
  benchmark_k6_http.js
```

If using multi-worker mode (`./start_wrapper_workers.sh`), run against Nginx:

```bash
cd k6_mongo_ohcl

API_BASE_URL=http://localhost:9010 ./run_benchmark.sh
```

## Environment Variables

### Wrapper (`main.go`)

| Variable | Default | Description |
|---|---|---|
| `MONGO_URI` | `mongodb://localhost:27017` | MongoDB connection string |
| `DB_NAME` | `ohcl_data` | Database name |
| `ONED_EQ_COLLECTION` | `oned-eq` | Default find collection |
| `HISTORIC_EQ_COLLECTION` | `historic-eq` | Default aggregate collection |
| `PORT` | `8080` | HTTP listen port |
| `DEBUG` | `false` | Enable debug logs |

### k6 (`benchmark_k6_http.js`)

| Variable | Default | Description |
|---|---|---|
| `API_BASE_URL` | `http://localhost:9000` | Wrapper URL |
| `TOTAL_RPS` | `100` | Total request rate across all scenarios |
| `PREALLOCATED_VUS` | `50` | Pre-allocated VUs per scenario |
| `MAX_VUS` | `500` | Max VUs per scenario |
| `RATE_STEP` | `1` | Rate increment step (req/s) |
| `RATE_STEP_SECONDS` | `5` | Seconds per rate increment |
| `MINUTES` | `2` | Steady-state duration after ramp |
| `ONED_EQ_COLLECTION` | `oned-eq` | Target collection for oned_eq scenarios |
| `HISTORIC_EQ_COLLECTION` | `historic-eq` | Target collection for historic_eq scenarios |
| `ONED_FNO_COLLECTION` | `oned-fno` | Target collection for oned_fno scenarios |
| `AGG_MIN_TS` | `2026-05-07T00:00:00Z` | Min timestamp for random agg window |
| `AGG_MAX_TS` | `2026-06-02T00:00:00Z` | Max timestamp for random agg window |

## Metrics

Custom metrics emitted:

- `oned_eq_1m_find_latency_ms`
- `oned_eq_5m_agg_latency_ms`
- `historic_eq_3d_5m_agg_latency_ms`
- `historic_eq_3d_1m_find_latency_ms`
- `historic_eq_15_30m_agg_latency_ms`
- `find_errors`
- `agg_errors`
- `http_errors`

## Notes

- `FIND_WAIT_MS` and `AGG_WAIT_MS` were removed because pacing is controlled by arrival-rate executors.
- The wrapper redacts sensitive connection details from logs.
