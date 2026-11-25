import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { parseTargets, runBench, summaryLines } from './bench-run.mjs'

const RATES = {
  _note: 'test rates',
  s3: { storagePerGbMonth: 0.02, getPer1k: 0.0004, egressPerGb: 0.1, freeEgressGbPerMonth: 0 },
  cdn: { egressPerGb: 0.05, cacheFillPerGb: 0.01, lookupPer10k: 0.01 },
}
const media = (n) => `#EXTM3U\n#EXT-X-MAP:URI="init-${n}.m4s"\n${[1, 2, 3].map((i) => `#EXTINF:4.000000,\nchunk-${n}-0000${i}.m4s\n`).join('')}#EXT-X-ENDLIST\n`

let originDir
before(() => {
  originDir = mkdtempSync(join(tmpdir(), 'bench-run-'))
  mkdirSync(join(originDir, 'demo'))
  writeFileSync(join(originDir, 'demo', 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nmedia_1.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3\nmedia_2.m3u8\n')
  for (const n of [0, 1, 2]) writeFileSync(join(originDir, 'demo', `media_${n}.m3u8`), media(n))
})
after(() => rmSync(originDir, { recursive: true, force: true }))

/** A fetch that records every URL and answers with `bytes` bytes, cache-hit for hosts named cdn. */
function stub() {
  const urls = []
  const fetchFn = async (url) => {
    urls.push(url)
    return new Response(new Uint8Array(1000), { headers: { 'x-cache': new URL(url).host.startsWith('cdn') ? 'HIT' : 'MISS' } })
  }
  return { urls, fetchFn }
}
const base = (over = {}) => ({ targets: parseTargets(['local=http://local:1/', 'cdn=http://cdn:2']), slug: 'demo', rounds: 3, segments: 2, rates: RATES, originDir, ...over })

test('every target fetches the same objects: both manifests of a middle rung and the first segments', async () => {
  const { urls, fetchFn } = stub()
  const report = await runBench({ ...base(), fetchFn })
  const paths = (host) => urls.filter((u) => u.startsWith(host)).map((u) => new URL(u).pathname)
  assert.deepEqual(paths('http://local:1'), paths('http://cdn:2'))
  assert.deepEqual(paths('http://local:1').slice(0, 4), ['/demo/master.m3u8', '/demo/media_1.m3u8', '/demo/chunk-1-00001.m4s', '/demo/chunk-1-00002.m4s'])
  assert.equal(urls.length, 2 * 3 * 4)
  assert.equal(report.config.rung, 'media_1.m3u8')
  assert.deepEqual(report.config.targets, [{ name: 'local', base: 'http://local:1' }, { name: 'cdn', base: 'http://cdn:2' }])
})

test('the starting target rotates each round', async () => {
  const { urls, fetchFn } = stub()
  await runBench({ ...base({ rounds: 2 }), fetchFn })
  const firsts = urls.filter((u) => u.endsWith('master.m3u8')).map((u) => new URL(u).host)
  assert.deepEqual(firsts, ['local:1', 'cdn:2', 'cdn:2', 'local:1'])
})

test('the report has the shape the benchmark panel reads, and a measured hit ratio feeds the cost', async () => {
  const report = await runBench({ ...base(), fetchFn: stub().fetchFn })
  assert.deepEqual(Object.keys(report).sort(), ['config', 'cost', 'generatedAt', 'perRound', 'results'])
  assert.equal(report.results.cdn.hitRatio, 1)
  assert.equal(report.results.local.requests, 12)
  assert.equal(report.perRound.local.length, 3)
  assert.equal(report.cost.assumptions.hitRatioSource, 'measured')
  assert.equal(report.cost.scenarios.length, 3)
  assert.equal(report.cost.ratesNote, 'test rates')
  const noCdn = await runBench({ ...base({ targets: parseTargets(['local=http://local:1']) }), fetchFn: stub().fetchFn })
  assert.match(noCdn.cost.assumptions.hitRatioSource, /assumed/)
})

test('progress and log lines come once per round, ending at 1', async () => {
  const progress = []
  const lines = []
  await runBench({ ...base(), fetchFn: stub().fetchFn }, { progress: (p) => progress.push(p), log: (l) => lines.push(l) })
  assert.deepEqual(progress, [1 / 3, 2 / 3, 1])
  assert.match(lines[0], /^slug=demo rung=media_1.m3u8 segments=2 rounds=3 targets=local,cdn$/)
  assert.equal(lines.filter((l) => /^round \d of 3$/.test(l)).length, 3)
})

test('a failing target is counted, not fatal', async () => {
  const fetchFn = async (url) => {
    if (url.startsWith('http://cdn')) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    return new Response(new Uint8Array(10))
  }
  const report = await runBench({ ...base({ rounds: 1 }), fetchFn })
  assert.equal(report.results.cdn.errors, 4)
  assert.equal(report.results.local.errors, 0)
})

test('it can be stopped between rounds', async () => {
  const ac = new AbortController()
  const { fetchFn } = stub()
  await assert.rejects(runBench({ ...base({ rounds: 5 }), fetchFn }, { signal: ac.signal, progress: () => ac.abort() }), { name: 'AbortError' })
})

test('a missing title, no targets or an empty master are errors with a reason', async () => {
  await assert.rejects(runBench({ ...base({ slug: 'nope' }), fetchFn: stub().fetchFn }), /ENOENT/)
  await assert.rejects(runBench({ ...base({ targets: [] }), fetchFn: stub().fetchFn }), /at least one target/)
  mkdirSync(join(originDir, 'empty'))
  writeFileSync(join(originDir, 'empty', 'master.m3u8'), '#EXTM3U\n')
  await assert.rejects(runBench({ ...base({ slug: 'empty' }), fetchFn: stub().fetchFn }), /no media playlists/)
})

test('targets parse as name=url with the trailing slash dropped, and a bad one is refused', () => {
  assert.deepEqual(parseTargets(['a=http://x/']), [{ name: 'a', base: 'http://x' }])
  assert.throws(() => parseTargets(['nourl']), /bad target/)
})

test('the summary has a header and one line per target', async () => {
  const lines = summaryLines(await runBench({ ...base(), fetchFn: stub().fetchFn }))
  assert.equal(lines.length, 3)
  assert.match(lines[1], /^local /)
})
