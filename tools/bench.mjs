#!/usr/bin/env node
// Delivery benchmark CLI: fetches the same packaged title through several base URLs ("targets") and compares
// latency, throughput and cache behaviour (the work is in tools/bench-run.mjs, which the Workflows also call).
//
// Usage:
//   node tools/bench.mjs --target local=http://localhost:8788 [--target s3=https://bucket.s3.../media]
//        [--slug bbb] [--rounds 5] [--segments 6] [--out bench/report.json]
//
// A target is any host serving the layout of origin/ (master.m3u8, media_N.m3u8, chunk-*.m4s).
// Later: `s3=https://<bucket>.s3.<region>.amazonaws.com/media` and `cdn=https://<edge>/s3`.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { parseTargets, runBench, summaryLines } from './bench-run.mjs'

const { values } = parseArgs({
  options: {
    target: { type: 'string', multiple: true },
    slug: { type: 'string', default: 'bbb' },
    rounds: { type: 'string', default: '5' },
    segments: { type: 'string', default: '6' },
    out: { type: 'string', default: 'bench/report.json' },
    rates: { type: 'string', default: 'bench/rates.json' },
  },
})
if (!values.target?.length) {
  console.error('need at least one --target name=baseUrl')
  process.exit(2)
}

const report = await runBench(
  {
    targets: parseTargets(values.target),
    slug: values.slug,
    rounds: Number(values.rounds),
    segments: Number(values.segments),
    rates: JSON.parse(await readFile(values.rates, 'utf8')),
  },
  { log: (line) => console.log(line) },
)
await mkdir(dirname(values.out), { recursive: true })
await writeFile(values.out, JSON.stringify(report, null, 2) + '\n')
console.log('\n' + summaryLines(report).join('\n'))
console.log(`\nreport written to ${values.out}`)
