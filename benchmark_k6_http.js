/**
 * k6 benchmark using HTTP wrapper for MongoDB queries.
 *
 * 5 query types in parallel:
 *   1. find_1min_eq         — find all 1-min candles for one EQ ID
 *   2. agg_5min_eq          — aggregate 5-min OHLC candles for one EQ ID
 *   3. find_1min_historic   — find all 1-min candles for one FNO ID for a date
 *   4. find_historic        — find 3 days of 1-min candles for one ID from historic-eq
 *   5. agg_historic         — aggregate historic-eq into random 15/30-min OHLC bins
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
 *   USERS              — VUs per scenario           (default: 20)
 *   MINUTES            — duration of each scenario  (default: 2)
 *   FIND_WAIT_MS       — sleep after each find (ms) (default: 1)
 *   AGG_WAIT_MS        — sleep after each agg  (ms) (default: 10)
 *   ONED_EQ_COLLECTION      — oned-eq collection (default: oned-eq)
 *   HISTORIC_EQ_COLLECTION  — historic-eq collection (default: historic-eq)
 *   HISTORIC_FNO_COLLECTION — historic-fno collection (default: historic-fno)
 *   AGG_MIN_TS         — oldest ts for agg window   (default: 2024-01-01T00:00:00Z)
 *   AGG_MAX_TS         — newest ts for agg window   (default: 2026-06-11T00:00:00Z)
 */

import http from 'k6/http';
import { Trend, Counter } from 'k6/metrics';
import { sleep } from 'k6';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_BASE_URL = __ENV.API_BASE_URL  || 'http://localhost:9000';
const USERS        = parseInt(__ENV.USERS   || '20');
const MINUTES      = parseInt(__ENV.MINUTES || '2');
const FIND_WAIT_MS = parseFloat(__ENV.FIND_WAIT_MS || '1');
const AGG_WAIT_MS  = parseFloat(__ENV.AGG_WAIT_MS  || '10');
const ONED_EQ_COLLECTION     = __ENV.ONED_EQ_COLLECTION     || 'oned-eq';
const HISTORIC_EQ_COLLECTION = __ENV.HISTORIC_EQ_COLLECTION || 'historic-eq';
const HISTORIC_FNO_COLLECTION = __ENV.HISTORIC_FNO_COLLECTION || 'historic-fno';

// Fixed date window used by the find phase (mirrors the Python hardcode)
const FIND_START_TS = '2026-06-11T09:15:00Z';
const FIND_END_TS   = '2026-06-11T15:30:00Z';

// Timestamp range for aggregate random windows (supply via env for accuracy)
const AGG_MIN_TS = __ENV.AGG_MIN_TS || '2026-05-07T00:00:00Z';
const AGG_MAX_TS = __ENV.AGG_MAX_TS || '2026-06-02T00:00:00Z';

const HISTORIC_DATE_START_TS = __ENV.HISTORIC_DATE_START_TS || '2026-06-10T00:00:00Z';
const HISTORIC_DATE_END_TS   = __ENV.HISTORIC_DATE_END_TS   || '2026-06-11T00:00:00Z';
const HISTORIC_3D_START_TS   = __ENV.HISTORIC_3D_START_TS   || '2026-06-08T00:00:00Z';
const HISTORIC_3D_END_TS     = __ENV.HISTORIC_3D_END_TS     || '2026-06-11T00:00:00Z';

const SYMBOL_POOL = [
  'JYOTICNC.NS', 'M&MFIN.NS', 'KPITTECH.NS', 'REDINGTON.NS', 'RTNPOWER.BO',
  'LENSKART.NS', 'RECLTD.NS', 'BLACKBUCK.NS', 'CAMS.NS', 'EICHERMOT.NS',
  'APTUS.NS', 'IPCALAB.NS', 'MFSL.NS', 'TECHM.NS', 'UNITDSPR.NS',
  'GLENMARK.NS', 'HDFCAMC.NS', 'FORCEMOT.NS', 'CUPID.NS', 'IRFC.NS',
  'BIKAJI.NS', 'WOCKPHARMA.NS', 'DATAPATTNS.NS', 'IOC.NS', 'WIPRO.BO',
];

const FNO_ID_POOL = [
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX',
];

// ---------------------------------------------------------------------------
// Custom metrics  (mirror the Python per-bin-size breakdowns)
// ---------------------------------------------------------------------------
const find1minEqLatencyMs       = new Trend('find_1min_eq_latency_ms', true);
const agg5minEqLatencyMs        = new Trend('agg_5min_eq_latency_ms', true);
const find1minHistoricLatencyMs = new Trend('find_1min_historic_latency_ms', true);
const findHistoricLatencyMs     = new Trend('find_historic_latency_ms', true);
const aggHistoricLatencyMs      = new Trend('agg_historic_latency_ms', true);
const aggHistoric15mLatencyMs   = new Trend('agg_historic_15m_latency_ms', true);
const aggHistoric30mLatencyMs   = new Trend('agg_historic_30m_latency_ms', true);
const findErrors                = new Counter('find_errors');
const aggErrors                 = new Counter('agg_errors');
const httpErrors    = new Counter('http_errors');

// ---------------------------------------------------------------------------
// k6 options — 5 scenarios running in parallel
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    find_1min_eq: {
      executor:  'constant-vus',
      vus:       USERS,
      duration:  `${MINUTES}m`,
      startTime: '0s',
      exec:      'find1minEqScenario',
      tags:      { scenario: 'find_1min_eq' },
    },
    agg_5min_eq: {
      executor:  'constant-vus',
      vus:       USERS,
      duration:  `${MINUTES}m`,
      startTime: '0s',
      exec:      'agg5minEqScenario',
      tags:      { scenario: 'agg_5min_eq' },
    },
    find_1min_historic: {
      executor:  'constant-vus',
      vus:       USERS,
      duration:  `${MINUTES}m`,
      startTime: '0s',
      exec:      'find1minHistoricScenario',
      tags:      { scenario: 'find_1min_historic' },
    },
    find_historic: {
      executor:  'constant-vus',
      vus:       USERS,
      duration:  `${MINUTES}m`,
      startTime: '0s',
      exec:      'findHistoricScenario',
      tags:      { scenario: 'find_historic' },
    },
    agg_historic: {
      executor:  'constant-vus',
      vus:       USERS,
      duration:  `${MINUTES}m`,
      startTime: '0s',
      exec:      'aggHistoricScenario',
      tags:      { scenario: 'agg_historic' },
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
function runFind(payload, trend) {
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
      trend.add(body.duration_ms);
    }
  } catch (e) {
    findErrors.add(1);
  }

  sleep(FIND_WAIT_MS / 1000);
}

function runAggregate(payload, trend, binSize) {
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
      trend.add(elapsedMs);
      if (binSize === 15) aggHistoric15mLatencyMs.add(elapsedMs);
      if (binSize === 30) aggHistoric30mLatencyMs.add(elapsedMs);
    }
  } catch (e) {
    aggErrors.add(1);
  }

  sleep(AGG_WAIT_MS / 1000);
}

// ---------------------------------------------------------------------------
// Scenario 1 — find all 1-min candles for one EQ ID
// ---------------------------------------------------------------------------
export function find1minEqScenario() {
  const symbol = randomChoice(SYMBOL_POOL);

  const payload = {
    collection: ONED_EQ_COLLECTION,
    filter: {
      id: symbol,
      ts: {
        $gte: FIND_START_TS,
        $lt: FIND_END_TS,
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

  runFind(payload, find1minEqLatencyMs);
}

// ---------------------------------------------------------------------------
// Scenario 2 — aggregate 5-min OHLC candles for one EQ ID
// ---------------------------------------------------------------------------
export function agg5minEqScenario() {
  const symbol = randomChoice(SYMBOL_POOL);
  const payload = {
    collection: ONED_EQ_COLLECTION,
    pipeline: [
      {
        $match: {
          id: symbol,
          ts: {
            $gte: FIND_START_TS,
            $lt: FIND_END_TS,
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

  runAggregate(payload, agg5minEqLatencyMs);
}

// ---------------------------------------------------------------------------
// Scenario 3 — find all 1-min candles for one FNO ID for a date
// ---------------------------------------------------------------------------
export function find1minHistoricScenario() {
  const fnoId = randomChoice(FNO_ID_POOL);
  const payload = {
    collection: HISTORIC_FNO_COLLECTION,
    filter: {
      id: fnoId,
      ts: {
        $gte: HISTORIC_DATE_START_TS,
        $lt: HISTORIC_DATE_END_TS,
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

  runFind(payload, find1minHistoricLatencyMs);
}

// ---------------------------------------------------------------------------
// Scenario 4 — find 3 days of 1-min candles for one ID from historic-eq
// ---------------------------------------------------------------------------
export function findHistoricScenario() {
  const symbol = randomChoice(SYMBOL_POOL);
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

  runFind(payload, findHistoricLatencyMs);
}

// ---------------------------------------------------------------------------
// Scenario 5 — aggregate historic-eq into random 15/30-min OHLC bins
// ---------------------------------------------------------------------------
export function aggHistoricScenario() {
  const symbol = randomChoice(SYMBOL_POOL);
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

  runAggregate(payload, aggHistoricLatencyMs, binSize);
}
