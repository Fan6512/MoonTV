/* eslint-disable no-console */

import { cache } from 'react';

type ObserveScope = {
  rid: string;
  t0: number;
  seq: number;
};

// React's request-scoped cache: one render -> one scope object, shared by
// generateMetadata, RootLayout and every getAdminConfig within that render.
// No headers, cookies, env values, URL credentials or user data is read.
const requestScope = cache(
  (): ObserveScope => ({
    rid: crypto.randomUUID(),
    t0: performance.now(),
    seq: 0,
  })
);

// Isolate-scoped, non-sensitive cold/warm hints.
const ISOLATE_ID = crypto.randomUUID();
const ISOLATE_START = performance.now();
let firstObservation = true;

// No env vars are read. The serving region is collected client-side from the
// x-vercel-id response header (entry::execution::id) instead, so this module
// never touches dynamic APIs, environment values or request headers.

export function observeScope(): ObserveScope {
  return requestScope();
}

export function markConfigRead(scope: ObserveScope): number {
  scope.seq += 1;
  return scope.seq;
}

export function ms(start: number): number {
  return Math.round((performance.now() - start) * 100) / 100;
}

export function observeLog(
  event: string,
  scope: ObserveScope | null,
  fields: Record<string, number | string | boolean>
): void {
  const cold = firstObservation;
  if (cold) firstObservation = false;
  console.log(
    JSON.stringify({
      perf: 1,
      event,
      rid: scope ? scope.rid : 'none',
      runtime: 'edge',
      isolate_id: ISOLATE_ID,
      isolate_age_ms: Math.round(performance.now() - ISOLATE_START),
      cold_hint: cold,
      since_request_ms: scope ? ms(scope.t0) : 0,
      ...fields,
    })
  );
}
