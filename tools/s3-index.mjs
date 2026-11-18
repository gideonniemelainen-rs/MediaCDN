#!/usr/bin/env node
// Builds index.json from what is actually in the bucket under media/ and (with --go) uploads it to
// media/index.json. Needs the AWS CLI and a profile that can list and write media/ (mediacdn-uploader).
// Usage: S3_BUCKET=<bucket> node tools/s3-index.mjs [--go]
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildIndex } from './index-lib.mjs'

const run = promisify(execFile)
const bucket = process.env.S3_BUCKET
if (!bucket) throw new Error('set S3_BUCKET')
const env = { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE ?? 'mediacdn-uploader' }
const aws = async (...args) => JSON.parse((await run('aws', [...args, '--output', 'json'], { env })).stdout || 'null')

// Title folders: the common prefixes directly under media/.
const top = await aws('s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', 'media/', '--delimiter', '/')
const slugs = (top?.CommonPrefixes ?? []).map((p) => p.Prefix.slice('media/'.length, -1))

// Only the manifests matter, so check those two keys per title instead of listing every segment.
const listing = []
for (const slug of slugs) {
  const files = []
  for (const name of ['master.m3u8', 'manifest.mpd']) {
    const key = `media/${slug}/${name}`
    const r = await aws('s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', key, '--max-items', '1')
    if (r?.Contents?.some((o) => o.Key === key)) files.push(name)
  }
  listing.push({ slug, files })
}

const index = buildIndex(listing)
const text = JSON.stringify(index, null, 2) + '\n'
console.log(text)
if (process.argv.includes('--go')) {
  const file = join(tmpdir(), `index-${process.pid}.json`)
  await writeFile(file, text)
  await run(
    'aws',
    ['s3', 'cp', file, `s3://${bucket}/media/index.json`, '--content-type', 'application/json', '--cache-control', 'public, max-age=60'],
    { env },
  )
  console.log(`uploaded s3://${bucket}/media/index.json`)
} else {
  console.log('(dry run: pass --go to upload)')
}
