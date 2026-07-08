/**
 * k6 benchmark: only oned-eq-packed find scenario.
 *
 * Runs one scenario that performs /find on oned-eq-packed using symbols_eq.csv.
 *
 * Env vars:
 *   API_BASE_URL               default: http://localhost:9010
 *   RPS                        default: TOTAL_RPS or 100
 *   TOTAL_RPS                  optional fallback for RPS
 *   PREALLOCATED_VUS           default: 50
 *   MAX_VUS                    default: 500
 *   MINUTES                    default: 1
 *   ONED_EQ_PACKED_COLLECTION  default: oned-eq-packed
 */

import http from 'k6/http';
import { Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const API_BASE_URL = __ENV.API_BASE_URL || 'http://localhost:9010';
const RPS = parseInt(__ENV.RPS || __ENV.TOTAL_RPS || '100', 10);
const PREALLOCATED_VUS = parseInt(__ENV.PREALLOCATED_VUS || '50', 10);
const MAX_VUS = parseInt(__ENV.MAX_VUS || '500', 10);
const MINUTES = parseInt(__ENV.MINUTES || '1', 10);
const ONED_EQ_PACKED_COLLECTION = __ENV.ONED_EQ_PACKED_COLLECTION || 'oned-eq-packed';

const findOnedEqPackedLatencyMs = new Trend('find_oned_eq_packed_latency_ms', true);
const findOnedEqPackedCountDocs = new Trend('find_oned_eq_packed_count', false);
const findOnedEqPackedAttempts = new Counter('find_oned_eq_packed_attempts');
const findOnedEqPackedFailures = new Counter('find_oned_eq_packed_failures');
const httpErrors = new Counter('http_errors');

function parseSymbolsCsv(content) {
  const symbols = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (symbols.length === 0) {
    throw new Error('symbols_eq.csv is empty; provide at least one symbol');
  }

  return symbols;
}

const SYMBOL_POOL_EQ = new SharedArray('symbols_eq', function () {
  return parseSymbolsCsv(open('./symbols_eq.csv'));
});

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

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

export const options = {
  scenarios: {
    oned_eq_packed_find_only: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages: buildRateStages(RPS),
      exec: 'findOnedEqPackedScenario',
      tags: { scenario: 'oned_eq_packed_find_only' },
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export function setup() {
  const res = http.get(`${API_BASE_URL}/health`);
  if (res.status !== 200) {
    throw new Error(`API health check failed: ${res.status}`);
  }

  console.log('API health check passed');
  console.log(`Loaded ${SYMBOL_POOL_EQ.length} symbols for packed find`);
  console.log(`Target collection: ${ONED_EQ_PACKED_COLLECTION}`);
}

export function findOnedEqPackedScenario() {
  const symbol = randomChoice(SYMBOL_POOL_EQ);
  findOnedEqPackedAttempts.add(1);

  const payload = {
    collection: ONED_EQ_PACKED_COLLECTION,
    filter: {
      id: symbol,
    },
    projection: {
      _id: 0,
      'data.1d': 1,
      count: 1,
    },
  };

  const res = http.post(`${API_BASE_URL}/find`, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    tags: { endpoint: 'find' },
  });

  if (res.status !== 200) {
    findOnedEqPackedFailures.add(1);
    httpErrors.add(1);
    return;
  }

  try {
    const body = JSON.parse(res.body);
    if (body.duration_ms !== undefined) {
      findOnedEqPackedLatencyMs.add(body.duration_ms);
      if (body.count !== undefined) {
        findOnedEqPackedCountDocs.add(body.count);
      }
    }
  } catch (e) {
    // Ignore parse/body-level issues for failure counters; only HTTP failures count.
  }
}
