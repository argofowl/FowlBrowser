// trace_start / trace_stop / trace_insight: a page-load trace of the perf page (LCP, long task, render-blocking CSS),
// then an interaction trace around a slow click (INP), and the tab keeps working after both.
import fs from 'node:fs';
import zlib from 'node:zlib';

export default {
  name: 'trace',
  async run(t) {
    const tab = await t.open(`${t.site}/perf.html?t=${t.tag}`);

    t.step('page-load trace');
    const load = (await t.call('trace_start', { tab, reload: true, seconds: 2 }, 120_000)).text;
    const sets = load.split('\n').filter((l) => /^(\w+_\d+|NO_NAVIGATION|Trace|LCP):/.test(l)).join(' | ');
    t.ok(/^NAVIGATION_0: /m.test(load), `insight set: ${sets}`);
    // Numbers are printed with thousands separators: a background tab's render delay often passes 1,000 ms.
    t.ok(/^LCP: \d[\d,]* ms \(TTFB [\d,]+ ms · .*render delay [\d,]+ ms\)/m.test(load), `LCP with subparts: ${load}`);
    t.ok(/^Long tasks: [1-9][\d,]* over 50 ms, longest [\d,]+ ms/m.test(load), `long task: ${load}`);
    t.ok(/^- RenderBlocking \(/m.test(load), `RenderBlocking among the insights: ${load}`);
    t.ok(/^INP: n\/a \(no interactions\)/m.test(load), `no INP without interactions: ${load}`);
    const file = /^File: (\S+\.json\.gz)/m.exec(load)?.[1];
    t.ok(file && fs.existsSync(file), `trace file exists: ${file}`);
    t.ok(Array.isArray(JSON.parse(zlib.gunzipSync(fs.readFileSync(file))).traceEvents), 'trace file gunzips to JSON with traceEvents');

    t.step('trace_insight');
    const lcp = (await t.call('trace_insight', { tab, name: 'LCPBreakdown' })).text;
    t.ok(/- TTFB: [\d,]+ ms/.test(lcp) && /- render delay: [\d,]+ ms/.test(lcp), `LCP subparts: ${lcp}`);
    const wrong = await t.call('trace_insight', { tab, name: 'NoSuchInsight' }).then(() => null, (e) => e.message);
    t.ok(/No insight "NoSuchInsight"\. Insights of the last trace: .*RenderBlocking/.test(wrong ?? ''), `unknown name lists names: ${wrong}`);

    t.step('interaction trace');
    const started = (await t.call('trace_start', { tab, reload: false, auto_stop: false })).text;
    t.ok(/Trace recording/.test(started), `recording: ${started}`);
    // A 200 ms handler under tracing can outlast the click's 1 s quick budget: give it the normal action timeout.
    await t.call('click', { tab, ref: await t.refOf(tab, 'button', 'Slow click'), snapshot: false, timeout_ms: 10_000 });
    t.eq(await t.eval(tab, `() => document.querySelector('#status').textContent`), 'slow:clicked', 'slow click ran while recording');
    const stopped = (await t.call('trace_stop', { tab }, 120_000)).text;
    const inp = /^INP: ([\d,]+) ms/m.exec(stopped)?.[1]?.replace(/,/g, '');
    t.ok(inp && Number(inp) >= 150 && Number(inp) < 1000, `INP around 200 ms: ${stopped.split('\n').filter((l) => /^(INP|Trace|Long tasks):/.test(l)).join(' | ')}`);

    t.step('trace_stop without a recording');
    const again = await t.call('trace_stop', { tab }).then(() => null, (e) => e.message);
    t.ok(/No trace is recording/.test(again ?? ''), `second trace_stop errors: ${again}`);

    t.step('third short trace');
    const third = (await t.call('trace_start', { tab, reload: false, auto_stop: true, seconds: 1 }, 120_000)).text;
    // An idle second may hold no insight set at all (the engine drops a short, all-passing one): check the trace itself.
    t.ok(/^Trace: \S+ · 1\.\d s · [\d,]+ events/m.test(third) && /^File: \S+\.json\.gz/m.test(third), `third trace works: ${third}`);

    t.step('tab still works');
    await t.call('click', { tab, ref: await t.refOf(tab, 'button', 'Leak'), snapshot: false });
    t.eq(await t.eval(tab, `() => document.querySelector('#status').textContent`), 'leaked 1', 'click after tracing');
  },
};
