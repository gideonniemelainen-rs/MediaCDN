#!/usr/bin/env node
// Probes every URL in media/sources.json: status, redirects, content type/length,
// range support and CORS. Usage: node scripts/probe-sources.mjs [origin]
import { readFile } from 'node:fs/promises'

const ORIGIN = process.argv[2] ?? 'http://localhost:5173'
const manifest = JSON.parse(
  await readFile(new URL('../media/sources.json', import.meta.url), 'utf8'),
)
const urls = [...manifest.titles.map((t) => t.url), ...(manifest.extraProbes ?? [])]

async function probe(url) {
  const out = { url, ok: false }
  try {
    // A ranged GET shows range support (206) and CORS without downloading the file.
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-1023', Origin: ORIGIN },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    })
    await res.body?.cancel()
    const h = (n) => res.headers.get(n) ?? '-'
    Object.assign(out, {
      ok: res.status === 200 || res.status === 206,
      status: res.status,
      finalUrl: res.url !== url ? res.url : undefined,
      type: h('content-type'),
      total: (h('content-range').split('/')[1] ?? h('content-length')),
      ranges: res.status === 206 ? 'yes (206)' : h('accept-ranges'),
      cors: h('access-control-allow-origin'),
    })
  } catch (e) {
    out.error = String(e.cause?.code ?? e.message)
  }
  return out
}

const results = await Promise.all(urls.map(probe))
for (const r of results) {
  console.log(`\n${r.ok ? 'OK  ' : 'FAIL'} ${r.url}`)
  if (r.error) console.log(`  error: ${r.error}`)
  else {
    console.log(`  status ${r.status}  type ${r.type}  total bytes ${r.total}`)
    console.log(`  range: ${r.ranges}  cors(Origin ${ORIGIN}): ${r.cors}`)
    if (r.finalUrl) console.log(`  redirected to ${r.finalUrl}`)
  }
}
const corsOk = results.filter((r) => r.ok && (r.cors === '*' || r.cors === ORIGIN)).length
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} reachable, ${corsOk} with usable CORS`)
