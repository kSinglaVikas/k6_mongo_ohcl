/**
 * k6 benchmark using HTTP wrapper for MongoDB queries.
 *
 * 5 query types in parallel:
 *   1. oned_eq_1m_find          — find all 1-min candles for one EQ ID for a date from oned-eq
 *   2. oned_eq_5m_agg           — aggregate 5-min OHLC candles for one EQ ID
 *   3. historic_eq_3d_5m_agg    — aggregate 3 days of historic-eq into 5-min OHLC bins
 *   4. historic_eq_3d_1m_find   — find 3 days of 1-min candles for one ID from historic-eq
 *   5. historic_eq_15_30m_agg   — aggregate historic-eq into random 15/30-min OHLC bins
 *   6. oned_fno_1m_find         — find all 1-min candles for one F&O ID from oned-fno
 *
 * Prerequisites:
 *   1. Build and run the Go wrapper service:
 *      go build -o mongo_wrapper main.go
 *      MONGO_URI="mongodb+srv://..." ./mongo_wrapper
 *
 *   2. Ensure k6 is installed:
 *      brew install k6   (on macOS)
 *
 * Run:
 *   k6 run benchmark_k6_http.js
 *
 * Tune via env vars (all optional):
 *   API_BASE_URL       — HTTP wrapper base URL      (default: http://localhost:8080)
 *   TOTAL_RPS          — total req/sec across scenarios (default: 100)
 *   PREALLOCATED_VUS   — pre-allocated VUs per scenario (default: 50)
 *   MAX_VUS            — max VUs per scenario          (default: 500)
 *   RATE_STEP          — minimum req/sec added per step (default: 1)
 *   RATE_STEP_SECONDS  — seconds per rate step         (default: 5)
 *   MINUTES            — duration of each scenario  (default: 2)
 *   ONED_EQ_COLLECTION      — oned-eq collection (default: oned-eq)
 *   HISTORIC_EQ_COLLECTION  — historic-eq collection (default: historic-eq)
 *   ONED_FNO_COLLECTION     — oned-fno collection (default: oned-fno)
 *   AGG_MIN_TS         — oldest ts for agg window   (default: 2024-01-01T00:00:00Z)
 *   AGG_MAX_TS         — newest ts for agg window   (default: 2026-06-11T00:00:00Z)
 */

import http from 'k6/http';
import { Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_BASE_URL = __ENV.API_BASE_URL  || 'http://localhost:9000';
const TOTAL_RPS    = parseInt(__ENV.TOTAL_RPS || '100');
const PREALLOCATED_VUS = parseInt(__ENV.PREALLOCATED_VUS || '50');
const MAX_VUS      = parseInt(__ENV.MAX_VUS || '500');
const RATE_STEP    = parseInt(__ENV.RATE_STEP || '1');
const RATE_STEP_SECONDS = parseInt(__ENV.RATE_STEP_SECONDS || '5');
const MINUTES      = parseInt(__ENV.MINUTES || '2');
const ONED_EQ_COLLECTION     = __ENV.ONED_EQ_COLLECTION     || 'oned-eq';
const HISTORIC_EQ_COLLECTION = __ENV.HISTORIC_EQ_COLLECTION || 'historic-eq';
const ONED_FNO_COLLECTION    = __ENV.ONED_FNO_COLLECTION    || 'oned-fno';

// Fixed date window used by the find phase (mirrors the Python hardcode)
const ONED_START_TS = '2026-06-03T03:45:00Z';
const ONED_END_TS   = '2026-06-03T10:00:00Z';

// F&O date window (2026-06-02)
const FNO_START_TS  = '2026-06-02T03:45:00Z';
const FNO_END_TS    = '2026-06-02T10:00:00Z';

// Timestamp range for aggregate random windows (supply via env for accuracy)
const AGG_MIN_TS = __ENV.AGG_MIN_TS || '2023-03-20T00:00:00Z';
const AGG_MAX_TS = __ENV.AGG_MAX_TS || '2023-05-05T00:00:00Z';

const HISTORIC_3D_START_TS   = __ENV.HISTORIC_3D_START_TS   || AGG_MIN_TS;
const HISTORIC_3D_END_TS     = __ENV.HISTORIC_3D_END_TS     || new Date(new Date(AGG_MIN_TS).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();

function parseSymbolsCsv(content) {
  const symbols = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (symbols.length === 0) {
    throw new Error('symbol CSV is empty; provide at least one symbol');
  }

  return symbols;
}

const SYMBOL_POOL_EQ = new SharedArray('symbols_eq', function () {
  return parseSymbolsCsv(open('./symbols_eq.csv'));
});
const SYMBOL_POOL_HISTORIC = new SharedArray('symbols_historic', function () {
  return parseSymbolsCsv(open('./symbols_historic.csv'));
});
const SYMBOL_POOL_FNO = new SharedArray('symbols_fno', function () {
  return parseSymbolsCsv(open('./symbols_fno.csv'));
});

// ---------------------------------------------------------------------------
// Custom metrics  (mirror the Python per-bin-size breakdowns)
// Prefixed with find_/agg_ to control sort order in summary (finds first)
// ---------------------------------------------------------------------------
// Latency trends
const find1minEqLatencyMs       = new Trend('find_oned_eq_1m_latency_ms', true);
const findHistoricLatencyMs     = new Trend('find_historic_eq_3d_1m_latency_ms', true);
const findFnoLatencyMs          = new Trend('find_oned_fno_1m_latency_ms', true);
const agg5minEqLatencyMs        = new Trend('agg_oned_eq_5m_latency_ms', true);
const aggHistoric3d5mLatencyMs  = new Trend('agg_historic_eq_3d_5m_latency_ms', true);
const aggHistoricLatencyMs      = new Trend('agg_historic_eq_15_30m_latency_ms', true);

// Count trends (documents returned)
const find1minEqCountDocs       = new Trend('find_oned_eq_1m_count', false);
const findHistoricCountDocs     = new Trend('find_historic_eq_3d_1m_count', false);
const findFnoCountDocs          = new Trend('find_oned_fno_1m_count', false);
const agg5minEqCountDocs        = new Trend('agg_oned_eq_5m_count', false);
const aggHistoric3d5mCountDocs  = new Trend('agg_historic_eq_3d_5m_count', false);
const aggHistoricCountDocs      = new Trend('agg_historic_eq_15_30m_count', false);

// Zero-result counters (count == 0)
const find1minEqZeroCount       = new Counter('find_oned_eq_1m_zero_count');
const findHistoricZeroCount     = new Counter('find_historic_eq_3d_1m_zero_count');
const findFnoZeroCount          = new Counter('find_oned_fno_1m_zero_count');
const agg5minEqZeroCount        = new Counter('agg_oned_eq_5m_zero_count');
const aggHistoric3d5mZeroCount  = new Counter('agg_historic_eq_3d_5m_zero_count');
const aggHistoricZeroCount      = new Counter('agg_historic_eq_15_30m_zero_count');

const findErrors                = new Counter('find_errors');
const aggErrors                 = new Counter('agg_errors');
const httpErrors    = new Counter('http_errors');

function buildRateStages(targetRate) {
  const safeTarget = Math.max(targetRate, 1);
  const totalSeconds = Math.max(Math.floor(MINUTES * 60), 1);

  if (totalSeconds === 1) {
    return [{ duration: '1s', target: safeTarget }];
  }

  const rampSeconds = Math.max(1, Math.floor(totalSeconds / 2));
  const holdSeconds = totalSeconds - rampSeconds;

  return [
    { duration: `${rampSeconds}s`, target: safeTarget },
    { duration: `${holdSeconds}s`, target: safeTarget },
  ];
}

const RATE_ONED_EQ_1M_FIND = Math.max(1, Math.round(TOTAL_RPS * 0.60));
const RATE_HIST_EQ_3D_1M_FIND = Math.max(1, Math.round(TOTAL_RPS * 0.10));
const RATE_ONED_FNO_1M_FIND   = Math.max(1, Math.round(TOTAL_RPS * 0.30));
const RATE_ONED_EQ_5M_AGG = Math.max(1, Math.round(TOTAL_RPS * 0.50));
const RATE_HIST_EQ_3D_5M_AGG = Math.max(1, Math.round(TOTAL_RPS * 0.20));
const RATE_HIST_EQ_15_30M_AGG = Math.max(1, Math.round(TOTAL_RPS * 0.30));
const PHASE_DURATION_SECONDS = Math.max(Math.floor(MINUTES * 60), 1);
const FIND_PHASE_START = '0s';
const AGG_PHASE_START = `${PHASE_DURATION_SECONDS}s`;

// ---------------------------------------------------------------------------
// k6 options — 2-phase execution (find first, then agg)
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    oned_eq_1m_find: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_ONED_EQ_1M_FIND),
      startTime: FIND_PHASE_START,
      exec:      'find1minEqScenario',
      tags:      { scenario: 'oned_eq_1m_find' },
    },
    oned_eq_5m_agg: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_ONED_EQ_5M_AGG),
      startTime: AGG_PHASE_START,
      exec:      'agg5minEqScenario',
      tags:      { scenario: 'oned_eq_5m_agg' },
    },
    historic_eq_3d_5m_agg: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_HIST_EQ_3D_5M_AGG),
      startTime: AGG_PHASE_START,
      exec:      'aggHistoric3d5mScenario',
      tags:      { scenario: 'historic_eq_3d_5m_agg' },
    },
    historic_eq_3d_1m_find: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_HIST_EQ_3D_1M_FIND),
      startTime: FIND_PHASE_START,
      exec:      'findHistoricScenario',
      tags:      { scenario: 'historic_eq_3d_1m_find' },
    },
    historic_eq_15_30m_agg: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_HIST_EQ_15_30M_AGG),
      startTime: AGG_PHASE_START,
      exec:      'aggHistoricScenario',
      tags:      { scenario: 'historic_eq_15_30m_agg' },
    },
    oned_fno_1m_find: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_ONED_FNO_1M_FIND),
      startTime: FIND_PHASE_START,
      exec:      'findFnoScenario',
      tags:      { scenario: 'oned_fno_1m_find' },
    },
  },
  // Surface all custom Trends in the end-of-test summary
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// ---------------------------------------------------------------------------
// Setup — verify the API is ready
// ---------------------------------------------------------------------------
export function setup() {
  const res = http.get(`${API_BASE_URL}/health`);
  if (res.status !== 200) {
    throw new Error(`API health check failed: ${res.status}`);
  }
  console.log('API health check passed');
  console.log(`Loaded ${SYMBOL_POOL_EQ.length} symbols for oned-eq`);
  console.log(`Loaded ${SYMBOL_POOL_HISTORIC.length} symbols for historic-eq`);
  console.log(`Loaded ${SYMBOL_POOL_FNO.length} symbols for oned-fno`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Pick a random [start, end) window of (binSizeMinutes * [40..200] bins) inside
 * [minTs, maxTs].  Mirrors _pick_random_window() from the Python script.
 */
function pickRandomWindow(minIso, maxIso, binSizeMinutes) {
  const minTs = new Date(minIso);
  const maxTs = new Date(maxIso);
  const totalMs      = Math.max(maxTs - minTs, 1);
  const binsInWindow = 40 + Math.floor(Math.random() * 161); // [40, 200]
  const windowMs     = binSizeMinutes * 60 * 1000 * binsInWindow;
  if (totalMs <= windowMs) {
    return [minIso, maxIso];
  }
  const offsetMs = Math.random() * (totalMs - windowMs);
  const startTs  = new Date(minTs.getTime() + offsetMs);
  const endTs    = new Date(startTs.getTime() + windowMs);
  return [startTs.toISOString(), endTs.toISOString()];
}

// ---------------------------------------------------------------------------
// Shared execution helpers
// ---------------------------------------------------------------------------
function runFind(payload, latencyTrend, countTrend, zeroCountCounter) {
  const res = http.post(`${API_BASE_URL}/find`, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    tags: { endpoint: 'find' },
  });

  if (res.status !== 200) {
    findErrors.add(1);
    httpErrors.add(1);
    return;
  }

  try {
    const body = JSON.parse(res.body);
    if (body.error) {
      findErrors.add(1);
    } else if (body.duration_ms !== undefined) {
      latencyTrend.add(body.duration_ms);
      if (body.count !== undefined) {
        countTrend.add(body.count);
        if (body.count === 0) {
          zeroCountCounter.add(1);
        }
      }
    }
  } catch (e) {
    findErrors.add(1);
  }
}

function runAggregate(payload, latencyTrend, countTrend, zeroCountCounter) {
  const res = http.post(`${API_BASE_URL}/aggregate`, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    tags: { endpoint: 'aggregate' },
  });

  if (res.status !== 200) {
    aggErrors.add(1);
    httpErrors.add(1);
    return;
  }

  try {
    const body = JSON.parse(res.body);
    if (body.error) {
      aggErrors.add(1);
    } else if (body.duration_ms !== undefined) {
      const elapsedMs = body.duration_ms;
      latencyTrend.add(elapsedMs);
      if (body.count !== undefined) {
        countTrend.add(body.count);
        if (body.count === 0) {
          zeroCountCounter.add(1);
        }
      }
    }
  } catch (e) {
    aggErrors.add(1);
  }
}

// ---------------------------------------------------------------------------
// Scenario 1 — find all 1-min candles for one EQ ID
// ---------------------------------------------------------------------------
export function find1minEqScenario() {
  const symbol = randomChoice(SYMBOL_POOL_EQ);

  const payload = {
    collection: ONED_EQ_COLLECTION,
    filter: {
      id: symbol,
      ts: {
        $gte: ONED_START_TS,
        $lt: ONED_END_TS,
      },
    },
    projection: {
      _id: 0,
      id: 0,
    },
    sort: {
      ts: 1,
    },
  };

  runFind(payload, find1minEqLatencyMs, find1minEqCountDocs, find1minEqZeroCount);
}

// ---------------------------------------------------------------------------
// Scenario 2 — aggregate 5-min OHLC candles for one EQ ID
// ---------------------------------------------------------------------------
export function agg5minEqScenario() {
  const symbol = randomChoice(SYMBOL_POOL_EQ);
  const payload = {
    collection: ONED_EQ_COLLECTION,
    pipeline: [
      {
        $match: {
          id: symbol,
          ts: {
            $gte: ONED_START_TS,
            $lt: ONED_END_TS,
          },
        },
      },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: '$ts',
              unit: 'minute',
              binSize: 5,
            },
          },
          o: { $first: '$o' },
          h: { $max: '$h' },
          l: { $min: '$l' },
          c: { $last: '$c' },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ],
  };

  runAggregate(payload, agg5minEqLatencyMs, agg5minEqCountDocs, agg5minEqZeroCount);
}

// ---------------------------------------------------------------------------
// Scenario 3 — aggregate 3 days of historic-eq into 5-min OHLC bins
// ---------------------------------------------------------------------------
export function aggHistoric3d5mScenario() {
  const symbol = randomChoice(SYMBOL_POOL_HISTORIC);
  const payload = {
    collection: HISTORIC_EQ_COLLECTION,
    pipeline: [
      {
        $match: {
          id: symbol,
          ts: {
            $gte: HISTORIC_3D_START_TS,
            $lt: HISTORIC_3D_END_TS,
          },
        },
      },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: '$ts',
              unit: 'minute',
              binSize: 5,
            },
          },
          o: { $first: '$o' },
          h: { $max: '$h' },
          l: { $min: '$l' },
          c: { $last: '$c' },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ],
  };

  runAggregate(payload, aggHistoric3d5mLatencyMs, aggHistoric3d5mCountDocs, aggHistoric3d5mZeroCount);
}

// ---------------------------------------------------------------------------
// Scenario 4 — find 3 days of 1-min candles for one ID from historic-eq
// ---------------------------------------------------------------------------
export function findHistoricScenario() {
  const symbol = randomChoice(SYMBOL_POOL_HISTORIC);
  const payload = {
    collection: HISTORIC_EQ_COLLECTION,
    filter: {
      id: symbol,
      ts: {
        $gte: HISTORIC_3D_START_TS,
        $lt: HISTORIC_3D_END_TS,
      },
    },
    projection: {
      _id: 0,
      id: 0,
    },
    sort: {
      ts: 1,
    },
  };

  runFind(payload, findHistoricLatencyMs, findHistoricCountDocs, findHistoricZeroCount);
}

// ---------------------------------------------------------------------------
// Scenario 5 — aggregate historic-eq into random 15/30-min OHLC bins
// ---------------------------------------------------------------------------
export function aggHistoricScenario() {
  const symbol = randomChoice(SYMBOL_POOL_HISTORIC);
  const binSize = randomChoice([15, 30]);
  const [startTs, endTs] = pickRandomWindow(AGG_MIN_TS, AGG_MAX_TS, binSize);

  const payload = {
    collection: HISTORIC_EQ_COLLECTION,
    pipeline: [
      {
        $match: {
          id: symbol,
          ts: {
            $gte: startTs,
            $lt: endTs,
          },
        },
      },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: '$ts',
              unit: 'minute',
              binSize: binSize,
            },
          },
          o: { $first: '$o' },
          h: { $max: '$h' },
          l: { $min: '$l' },
          c: { $last: '$c' },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ],
  };

  runAggregate(payload, aggHistoricLatencyMs, aggHistoricCountDocs, aggHistoricZeroCount);
}

// ---------------------------------------------------------------------------
// Scenario 6 — find all 1-min candles for one F&O ID from oned-fno
// ---------------------------------------------------------------------------
export function findFnoScenario() {
  const symbol = randomChoice(SYMBOL_POOL_FNO);

  const payload = {
    collection: ONED_FNO_COLLECTION,
    filter: {
      id: symbol,
      ts: {
        $gte: FNO_START_TS,
        $lte: FNO_END_TS,
      },
    },
    projection: {
      _id: 0,
      id: 0,
    },
    sort: {
      ts: 1,
    },
  };

  runFind(payload, findFnoLatencyMs, findFnoCountDocs, findFnoZeroCount);
}
