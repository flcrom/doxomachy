/**
 * Scheduled diary: one entry per UTC day of the scheduled event.
 *
 * Runs the real Mind Durable Object against FakeD1 (node:sqlite with the real
 * migrations) and an in-memory DO storage whose put() can be failed on demand,
 * so the D1-insert-then-state-save crash window is exercised end to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeD1, FailingD1 } from './helpers';

const DAY1 = '2026-09-24', DAY2 = '2026-09-25';
const WORDS = 'The memory held a few quiet beliefs today and I read them slowly, weighing each against the others, noticing which ones had been shielded and which stood alone, and I wrote down only what they said, nothing more, before the next round of visitors arrived to change the room again tonight.';

type Harness = {
  store: Map<string, any>;
  db: FailingD1;
  env: any;
  aiCalls: number;
  failNextStateSave: () => void;
  d1Reads: () => number;
  mind: () => Promise<any>;
};

function harness(opts: { ai?: () => Promise<unknown> } = {}): Harness {
  const store = new Map<string, any>();
  store.set('mind', { beliefs: [{ id: 'b1', text: 'Quiet systems deserve patient care.', alias: 'qa', shields: 1, createdAt: 1, tokens: 7 }], cycle: 1, version: 0, sessions: {}, issuance: {}, idempotency: {} });
  const fake = new FakeD1();
  let reads = 0;
  const counting: any = {
    prepare: (sql: string) => { if (/FROM diaries/.test(sql) && !/^INSERT/.test(sql)) reads++; return fake.prepare(sql); },
    batch: (s: any) => fake.batch(s),
  };
  const db = new FailingD1(counting as D1Database);
  let failSave = false;
  const h: Harness = {
    store, db, aiCalls: 0,
    env: null,
    failNextStateSave: () => { failSave = true; },
    d1Reads: () => reads,
    mind: async () => {
      const { Mind } = await import('../src/index');
      const state: any = {
        storage: {
          get: async (k: string) => structuredClone(store.get(k)),
          put: async (k: string, v: unknown) => { if (failSave) { failSave = false; throw new Error('storage unavailable'); } store.set(k, structuredClone(v)); },
        },
        blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
        getWebSockets: () => [],
      };
      const m = new Mind(state, h.env);
      await Promise.resolve();
      return m;
    },
  };
  h.env = {
    DB: db, DIARY_MODEL: '@cf/test-model',
    AI: { run: async () => { h.aiCalls++; return opts.ai ? opts.ai() : { response: WORDS }; } },
  };
  return h;
}

const post = (mind: any, day?: string, internal = true) => mind.fetch(new Request('https://mind.internal/v1/diary', {
  method: 'POST',
  headers: { ...(internal ? { 'x-internal-scheduled': '1' } : {}), ...(day ? { 'x-scheduled-day': day } : {}) },
}));
const rows = async (h: Harness) => (await (h.db as any).prepare('SELECT cycle,text,created_at FROM diaries ORDER BY CAST(cycle AS INTEGER)').all()).results as any[];
const at = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(`${DAY1}T00:00:05Z`);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('scheduled diary: one entry per UTC day', () => {
  it('writes the first entry and persists diaryDate on mind state', async () => {
    const h = harness(); const mind = await h.mind();
    const res = await post(mind, DAY1);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ written: true, cycle: '001' });
    expect(h.store.get('mind')).toMatchObject({ diaryDate: DAY1, cycle: 2, diary: { cycle: '001' } });
    expect((await rows(h)).map(r => r.cycle)).toEqual(['001']);
  });

  it('skips a same-day rerun before any Workers AI call or D1 read, even after a restart', async () => {
    const h = harness(); const mind = await h.mind();
    await post(mind, DAY1);
    const reads = h.d1Reads();
    at(`${DAY1}T06:00:03Z`);
    expect(await (await post(mind, DAY1)).json()).toEqual({ written: false, reason: 'already_written' });
    const restarted = await h.mind();
    at(`${DAY1}T12:00:03Z`);
    expect(await (await post(restarted, DAY1)).json()).toEqual({ written: false, reason: 'already_written' });
    expect(h.aiCalls).toBe(1);
    expect(h.d1Reads()).toBe(reads);
    expect(await rows(h)).toHaveLength(1);
    expect(h.store.get('mind').cycle).toBe(2);
  });

  it('racing fires for the same day write exactly one entry', async () => {
    const gates: Array<() => void> = [];
    const h = harness({ ai: () => new Promise(resolve => gates.push(() => resolve({ response: WORDS }))) });
    const mind = await h.mind();
    const a = post(mind, DAY1), b = post(mind, DAY1);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates.forEach(open => open());
    const bodies = await Promise.all([a, b].map(async p => (await p).json() as Promise<any>));
    expect(bodies.filter(x => x.written === true)).toHaveLength(1);
    expect(bodies.filter(x => x.reason === 'already_written')).toHaveLength(1);
    expect((await rows(h)).map(r => r.cycle)).toEqual(['001']);
    expect(h.store.get('mind')).toMatchObject({ diaryDate: DAY1, cycle: 2 });
  });

  it('D1 insert then DO save failure: rerun reconciles from D1 without a second cycle', async () => {
    const h = harness(); const mind = await h.mind();
    h.failNextStateSave();
    const crashed = await post(mind, DAY1);
    expect(crashed.status).toBe(500);
    expect(await rows(h)).toHaveLength(1); // D1 insert landed
    expect(h.store.get('mind').diaryDate).toBeUndefined(); // state save did not
    expect(h.store.get('mind').cycle).toBe(1);

    at(`${DAY1}T06:00:02Z`);
    const rerun = await post(mind, DAY1);
    expect(await rerun.json()).toEqual({ written: false, reason: 'already_written', reconciled: true });
    expect(h.aiCalls).toBe(1); // reconcile happens before Workers AI
    expect(h.store.get('mind')).toMatchObject({ diaryDate: DAY1, cycle: 2, diary: { cycle: '001' } });

    // A further tick after a restart stays a no-op and the cycle does not advance again.
    const restarted = await h.mind();
    at(`${DAY1}T12:00:02Z`);
    expect(await (await post(restarted, DAY1)).json()).toEqual({ written: false, reason: 'already_written' });
    expect(h.store.get('mind').cycle).toBe(2);

    at(`${DAY2}T00:00:04Z`);
    expect(await (await post(restarted, DAY2)).json()).toMatchObject({ written: true, cycle: '002' });
    const all = await rows(h);
    expect(all.map(r => r.cycle)).toEqual(['001', '002']); // day 1 kept, not overwritten
    expect(h.aiCalls).toBe(2);
    expect(h.store.get('mind')).toMatchObject({ diaryDate: DAY2, cycle: 3 });
  });

  it('D1 insert then DO save failure with no same-day rerun: the next day never reuses the cycle', async () => {
    const h = harness(); const mind = await h.mind();
    h.failNextStateSave();
    expect((await post(mind, DAY1)).status).toBe(500);
    const restarted = await h.mind();
    at(`${DAY2}T00:00:04Z`);
    expect(await (await post(restarted, DAY2)).json()).toMatchObject({ written: true, cycle: '002' });
    expect((await rows(h)).map(r => r.cycle)).toEqual(['001', '002']);
  });

  it('fails closed when the D1 reconcile read fails after a crashed write', async () => {
    const h = harness(); const mind = await h.mind();
    h.failNextStateSave();
    expect((await post(mind, DAY1)).status).toBe(500);
    h.db.failNext('WHERE created_at>=');
    at(`${DAY1}T06:00:02Z`);
    const res = await post(mind, DAY1);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'diary_reconcile_unavailable' });
    expect(h.aiCalls).toBe(1);
    expect(await rows(h)).toHaveLength(1);
    expect(h.store.get('mind').cycle).toBe(1);
    expect((console.error as any).mock.calls.some((c: unknown[]) => String(c[0]).includes('diary_reconcile_failed'))).toBe(true);
    // Once D1 is readable again the next tick reconciles instead of writing.
    at(`${DAY1}T12:00:02Z`);
    expect(await (await post(mind, DAY1)).json()).toMatchObject({ reason: 'already_written', reconciled: true });
    expect(await rows(h)).toHaveLength(1);
  });

  it('fails closed on a D1 read failure with no prior entry: no AI call, no write', async () => {
    const h = harness(); const mind = await h.mind();
    h.db.failNext('MAX(CAST');
    expect((await post(mind, DAY1)).status).toBe(503);
    expect(h.aiCalls).toBe(0);
    expect(await rows(h)).toHaveLength(0);
    expect(h.store.get('mind').diaryDate).toBeUndefined();
  });

  it('writes the next UTC day as a new cycle', async () => {
    const h = harness(); const mind = await h.mind();
    await post(mind, DAY1);
    at(`${DAY2}T00:00:04Z`);
    expect(await (await post(mind, DAY2)).json()).toMatchObject({ written: true, cycle: '002' });
    expect((await rows(h)).map(r => r.cycle)).toEqual(['001', '002']);
    expect(h.store.get('mind')).toMatchObject({ diaryDate: DAY2, cycle: 3 });
    expect(h.aiCalls).toBe(2);
  });

  it('adopts a legacy entry already written today (state without diaryDate)', async () => {
    const h = harness();
    await (h.db as any).prepare('INSERT INTO diaries (cycle,text,belief_ids,model,created_at) VALUES (?,?,?,?,?)').bind('004', WORDS, '[]', 'm', Date.parse(`${DAY1}T00:00:01Z`)).run();
    const mind = await h.mind();
    at(`${DAY1}T06:00:02Z`);
    expect(await (await post(mind, DAY1)).json()).toMatchObject({ reason: 'already_written', reconciled: true });
    expect(h.aiCalls).toBe(0);
    expect(h.store.get('mind')).toMatchObject({ diaryDate: DAY1, cycle: 5 });
  });

  it('skips a delivery whose scheduled day is not the current UTC day, and rejects malformed keys', async () => {
    const h = harness(); const mind = await h.mind();
    at(`${DAY2}T00:01:00Z`); // an 18:00 DAY1 tick delivered after midnight
    expect(await (await post(mind, DAY1)).json()).toEqual({ written: false, reason: 'day_mismatch' });
    expect((await post(mind, '2026-02-30')).status).toBe(400);
    expect((await post(mind, 'today')).status).toBe(400);
    expect(h.aiCalls).toBe(0);
    expect(await rows(h)).toHaveLength(0);
  });

  it('has no public or manual trigger', async () => {
    const h = harness(); const mind = await h.mind();
    expect((await post(mind, DAY1, false)).status).toBe(404);
    const calls: any[] = [];
    const env: any = { WEB_ORIGIN: 'https://doxomachy.flcrom.dev', MIND: { idFromName: () => ({}), get: () => ({ fetch: (...a: any[]) => { calls.push(a); return new Response('{}'); } }) } };
    const { worker } = await import('../src/index');
    for (const method of ['POST', 'GET']) {
      const r = await worker.fetch(new Request('https://api.example/v1/diary', { method, headers: { Origin: env.WEB_ORIGIN, 'x-internal-scheduled': '1', 'x-scheduled-day': DAY1 } }), env);
      expect(r.status).toBe(404);
    }
    expect(calls).toHaveLength(0);
    expect(h.aiCalls).toBe(0);
  });

  it('the cron passes the scheduled event day, not the delivery wall clock', async () => {
    const calls: any[] = [];
    const env: any = { MIND: { idFromName: () => ({}), get: () => ({ fetch: (...a: any[]) => { calls.push(a); return new Response('{}'); } }) } };
    const { worker } = await import('../src/index');
    at(`${DAY2}T00:00:30Z`);
    await worker.scheduled({ scheduledTime: Date.parse(`${DAY1}T18:00:00Z`), cron: '0 */6 * * *' } as any, env);
    expect(calls[0][0]).toBe('https://mind.internal/v1/diary');
    expect(calls[0][1].headers).toMatchObject({ 'x-internal-scheduled': '1', 'x-scheduled-day': DAY1 });
  });
});

describe('wrangler cron', () => {
  it('runs every 6 hours', async () => {
    const { readFileSync } = await import('node:fs');
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    expect(toml).toMatch(/^crons = \["0 \*\/6 \* \* \*"\]$/m);
  });
});
