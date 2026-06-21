# MongoDB Benchmark: k6 + Go Wrapper

This benchmark uses k6 plus a Go HTTP wrapper for MongoDB queries.

## Architecture

- `main.go`
  - `POST /find`
  - `POST /aggregate`
  - `GET /health`
- `benchmark_k6_http.js`
  - 5 weighted scenarios using `ramping-arrival-rate`

## Current Scenario Set

1. `oned_eq_1m_find` — find 1-minute candles for one EQ ID in `oned-eq`
2. `oned_eq_5m_agg` — aggregate 5-minute OHLC candles in `oned-eq`
3. `historic_eq_3d_5m_agg` — aggregate 3 days into 5-minute OHLC in `historic-eq`
4. `historic_eq_3d_1m_find` — find 3 days of 1-minute candles in `historic-eq`
5. `historic_eq_15_30m_agg` — aggregate `historic-eq` into random 15/30-minute OHLC bins

## Traffic Distribution

Traffic is distributed by request rate:

- `oned_eq_5m_agg`: 50%
- `oned_eq_1m_find`: 10%
- `historic_eq_3d_5m_agg`: 20%
- `historic_eq_3d_1m_find`: 5%
- `historic_eq_15_30m_agg`: 15%

Rates are derived from `TOTAL_RPS`.

## Setup

### 1. Generate symbols.csv

```bash
cd k6_mongo_ohcl

source .env && mongosh "$MONGO_URI" --quiet --eval '
  db.getSiblingDB("charts").getCollection("oned-eq").aggregate([
    { $group: { _id: "$id", cnt: { $count: {} } } },
    { $sort: { cnt: -1 } },
    { $limit: 400 },
    { $project: { cnt: 0 } }
  ]).toArray().map(d => d._id).join("\n")
' > symbols.csv
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
