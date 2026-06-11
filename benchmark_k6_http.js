/**
 * k6 benchmark using HTTP wrapper for MongoDB queries.
 *
 * Two sequential scenarios:
 *   1. find_benchmark  — random find() on <FIND_COLLECTION> with a fixed date window
 *   2. agg_benchmark   — random OHLC aggregation on <AGG_COLLECTION> with random bin size + window
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

// Fixed date window used by the find phase (mirrors the Python hardcode)
const FIND_START_TS = '2026-06-02T09:15:00Z';
const FIND_END_TS   = '2026-06-02T15:30:00Z';

// Timestamp range for aggregate random windows (supply via env for accuracy)
const AGG_MIN_TS = __ENV.AGG_MIN_TS || '2026-05-07T00:00:00Z';
const AGG_MAX_TS = __ENV.AGG_MAX_TS || '2026-06-02T00:00:00Z';

const SYMBOL_POOL = [
  'MFSL.NS',       'PNGJL.BO', 'ORICONENT.NS',  'OCCLLTD.BO',
  'ADANIGREEN.BO', 'CREATIVEYE.NS',  'CLEDUCATE.BO',  'SUNTV.BO',
  'DAICHI.BO',     'NITTAGELA.BO', 'CHEVIOT.BO',    'AARON.NS',
  'JUBLPHARMA.NS', 'ZFSTEERING.NS',  'GILLETTE.BO',   'SUDARSCHEM.NS',
  'CSBBANK.NS',    'SEDEMAC.NS',  'ALGOQUANT.NS',  'MOREPENLAB.NS',
  'WEWORK.BO',     'ASTRAL.BO',  '3IINFOLTD.NS',  'AEPL.NS',
  'AEROFLEX.BO', 'TCS.NS', 'HIKAL.BO', 'GODREJAGRO.NS', 'MINDTREE.NS',
  'MCDOWELL-N.BO', 'BIRLACORPN.BO', 'GODREJCP.NS', 'VOLTAS.NS', 'APOLLOHOSP.NS',
];

// ---------------------------------------------------------------------------
// Custom metrics  (mirror the Python per-bin-size breakdowns)
// ---------------------------------------------------------------------------
const findLatencyMs = new Trend('find_latency_ms',    true);
const aggLatencyMs  = new Trend('agg_latency_ms',     true);
const aggLatency5m  = new Trend('agg_latency_5m_ms',  true);
const aggLatency15m = new Trend('agg_latency_15m_ms', true);
const aggLatency30m = new Trend('agg_latency_30m_ms', true);
const findErrors    = new Counter('find_errors');
const aggErrors     = new Counter('agg_errors');
const httpErrors    = new Counter('http_errors');

// ---------------------------------------------------------------------------
// k6 options — two back-to-back scenarios, each lasting MINUTES minutes
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    find_benchmark: {
      executor:  'constant-vus',
      vus:       USERS,
      duration:  `${MINUTES}m`,
      startTime: '0s',
      exec:      'findScenario',
      tags:      { scenario: 'find' },
    },
    agg_benchmark: {
      executor:  'constant-vus',
      vus:       USERS,
      duration:  `${MINUTES}m`,
      startTime: '0s',   // starts in parallel with find_benchmark
      exec:      'aggScenario',
      tags:      { scenario: 'agg' },
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
// Scenario 1 — find()
// ---------------------------------------------------------------------------
export function findScenario() {
  const symbol = randomChoice(SYMBOL_POOL);
  
  const payload = {
    filter: {
      t: symbol,
      ts: {
        $gte: FIND_START_TS,
        $lt: FIND_END_TS,
      },
    },
    projection: {
      _id: 0,
      t: 0,
    },
    sort: {
      ts: 1,
    },
  };

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
      findLatencyMs.add(body.duration_ms);
    }
  } catch (e) {
    findErrors.add(1);
  }

  sleep(FIND_WAIT_MS / 1000);
}

// ---------------------------------------------------------------------------
// Scenario 2 — aggregate() OHLC candles
// ---------------------------------------------------------------------------
export function aggScenario() {
  const symbol         = randomChoice(SYMBOL_POOL);
  const binSize        = randomChoice([5, 15, 30]);
  const [startTs, endTs] = pickRandomWindow(AGG_MIN_TS, AGG_MAX_TS, binSize);

  const payload = {
    pipeline: [
      {
        $match: {
          t: symbol,
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
      aggLatencyMs.add(elapsedMs);
      if      (binSize ===  5) aggLatency5m.add(elapsedMs);
      else if (binSize === 15) aggLatency15m.add(elapsedMs);
      else                     aggLatency30m.add(elapsedMs);
    }
  } catch (e) {
    aggErrors.add(1);
  }

  sleep(AGG_WAIT_MS / 1000);
}
