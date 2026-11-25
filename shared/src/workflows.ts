// The Workflow registry's data: what the GUI can run (or show how to run), with typed parameters, the stage graph each
// run draws, and one validator for the parameters that the server applies and the Workflows page uses for inline errors.
// Pure, so it needs no server to test. The server's behaviour for each workflow (what it spawns) lives in
// pipeline/src/workflows/; nothing here runs anything. Parameters reuse the settings field types, so a value is checked
// the same way wherever it enters.
import { type FieldType, validateField } from './settings.ts'
import { SAFE_ID } from './title-layout.ts'

export type ParamType =
  | FieldType
  | { kind: 'target' }
  | { kind: 'list'; item: Exclude<ParamType, { kind: 'list' }>; min: number; max: number }
export type ParamValue = boolean | string | number | string[]
export type Params = Record<string, ParamValue>

export interface Param {
  key: string
  label: string
  help: string
  type: ParamType
  /** Must be given (or supplied by the caller's `defaults`). */
  required: boolean
  /** Used when the parameter is absent. */
  default?: ParamValue
}

export interface StageDef {
  id: string
  label: string
  needs: string[]
}

export interface GuideStep {
  title: string
  /** Exactly what to paste into a terminal. */
  command: string
  note: string
}

export interface Workflow {
  id: WorkflowId
  label: string
  summary: string
  /** `run`: the API runs it. `guide`: the page shows the commands and the API never runs it. */
  kind: 'run' | 'guide'
  /**
   * `dry-run-then-confirm`: a run without `confirm` is the dry run (stages: `dryRunStages`); the real run needs the id of
   * a successful dry run in `confirm` (the server checks it) and has `stages`.
   */
  safety: 'safe' | 'dry-run-then-confirm'
  params: readonly Param[]
  stages: readonly StageDef[]
  dryRunStages?: readonly StageDef[]
  guide?: readonly GuideStep[]
}

export const WORKFLOW_IDS = [
  'probe-sources',
  'fetch-sources',
  'package-title',
  'make-ads',
  'smoke-origin',
  'bench',
  'upload-s3',
  'rebuild-s3-index',
  'shape-network',
  'lab-certs',
  'chrome-lab',
] as const
export type WorkflowId = (typeof WORKFLOW_IDS)[number]

const stage = (id: string, label: string, ...needs: string[]): StageDef => ({ id, label, needs })

const slugType: ParamType = { kind: 'text', pattern: new RegExp(`^(?=.{1,64}$)${SAFE_ID.source.slice(1, -1)}$`), hint: 'a lowercase id of letters, digits and dashes (up to 64)' }
const bucketType: ParamType = { kind: 'text', pattern: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, hint: 'an S3 bucket name' }
const runIdType: ParamType = { kind: 'text', pattern: /^[A-Za-z0-9_-]{1,64}$/, hint: 'a run id' }

const slug = (key: string, label: string, help: string, required = true): Param => ({ key, label, help, type: slugType, required })
const slugs = (key: string, label: string, help: string): Param => ({ key, label, help, type: { kind: 'list', item: slugType, min: 0, max: 50 }, required: false })
const bucket: Param = { key: 'bucket', label: 'S3 bucket', help: 'Defaults to S3_BUCKET in the server\'s environment. Credentials come from the host AWS profile, never from here.', type: bucketType, required: true }
const confirm: Param = { key: 'confirm', label: 'Dry run to confirm', help: 'The id of a successful dry run of these same parameters. Leave empty to do the dry run.', type: runIdType, required: false }

export const WORKFLOWS: Readonly<Record<WorkflowId, Workflow>> = {
  'probe-sources': {
    id: 'probe-sources', label: 'Probe sources', kind: 'run', safety: 'safe',
    summary: 'Checks every public source in media/sources.json: status, redirects, range support and CORS.',
    params: [{ key: 'origin', label: 'Page origin', help: 'The browser origin to test CORS for.', type: { kind: 'url' }, required: false, default: 'http://localhost:5173' }],
    stages: [stage('probe', 'Probe')],
  },
  'fetch-sources': {
    id: 'fetch-sources', label: 'Fetch sources', kind: 'run', safety: 'safe',
    summary: 'Downloads titles from media/sources.json into media/src/ and skips the ones already there.',
    params: [slugs('ids', 'Titles', 'Leave empty for every title.')],
    stages: [stage('fetch', 'Fetch')],
  },
  'package-title': {
    id: 'package-title', label: 'Package a title', kind: 'run', safety: 'safe',
    summary: 'Packages media/src/<id>.mp4 into origin/<id>/ (HLS and DASH over CMAF) with the ABR ladder. Replaces the files already there.',
    params: [slug('id', 'Title', 'The source id.'), { key: 'quick', label: 'Quick ladder', help: 'Fewer rungs, faster.', type: { kind: 'boolean' }, required: false, default: false }],
    stages: [stage('probe', 'Probe height'), stage('package', 'Package', 'probe'), stage('verify', 'Verify', 'package')],
  },
  'make-ads': {
    id: 'make-ads', label: 'Make ad clips', kind: 'run', safety: 'safe',
    summary: 'Generates the ad test assets, packages them and writes the ad inventory under origin/ads/.',
    params: [slugs('ids', 'Ads', 'Leave empty for every ad.')],
    stages: [stage('make', 'Encode and package')],
  },
  'smoke-origin': {
    id: 'smoke-origin', label: 'Smoke-test the origin', kind: 'run', safety: 'safe',
    summary: 'Starts a throwaway origin and checks a packaged title: playlists, segments, ranges and the live simulation.',
    params: [slug('slug', 'Title', 'A packaged title; empty runs the built-in self test.', false)],
    stages: [stage('smoke', 'Smoke test')],
  },
  bench: {
    id: 'bench', label: 'Run the delivery benchmark', kind: 'run', safety: 'safe',
    summary: 'Fetches one packaged title through several base URLs, alternating rounds, and compares latency, throughput and cache behaviour. The report is saved with the run.',
    params: [
      { key: 'targets', label: 'Targets', help: 'name=base URL, e.g. local=http://localhost:8788', type: { kind: 'list', item: { kind: 'target' }, min: 1, max: 8 }, required: true },
      { key: 'slug', label: 'Title', help: 'The packaged title every target serves.', type: slugType, required: false, default: 'bbb' },
      { key: 'rounds', label: 'Rounds', help: 'How many times each target is fetched.', type: { kind: 'int', min: 1, max: 50 }, required: false, default: 5 },
      { key: 'segments', label: 'Segments', help: 'Segments fetched per round.', type: { kind: 'int', min: 1, max: 50 }, required: false, default: 6 },
    ],
    stages: [stage('run', 'Run'), stage('report', 'Write report', 'run')],
  },
  'upload-s3': {
    id: 'upload-s3', label: 'Upload a title to S3', kind: 'run', safety: 'dry-run-then-confirm',
    summary: 'Uploads origin/<slug>/ to s3://<bucket>/media/<slug>/ with explicit content types and cache headers, segments first and manifests last, then rebuilds the title index. Always a dry run first.',
    params: [slug('slug', 'Title', 'A packaged title in origin/.'), bucket, confirm],
    dryRunStages: [stage('dry-run', 'Dry run')],
    stages: [stage('upload', 'Upload'), stage('index', 'Rebuild index', 'upload')],
  },
  'rebuild-s3-index': {
    id: 'rebuild-s3-index', label: 'Rebuild the S3 title index', kind: 'run', safety: 'dry-run-then-confirm',
    summary: 'Lists what is really in the bucket under media/ and rewrites media/index.json. Always a dry run first.',
    params: [bucket, confirm],
    dryRunStages: [stage('dry-run', 'Dry run')],
    stages: [stage('index', 'Rebuild index')],
  },
  'shape-network': {
    id: 'shape-network', label: 'Shape the network (transport lab)', kind: 'guide', safety: 'safe',
    summary: 'Adds latency and packet loss to the transport lab ports on macOS so h3 can show a difference. Needs root, so it is run by hand.',
    params: [], stages: [],
    guide: [
      { title: 'Turn shaping on', command: 'sudo bash tools/shape.sh on 80 1', note: '80 ms round trip and 1 % loss; the arguments are rtt_ms, loss_pct and an optional lo0 MTU.' },
      { title: 'Check what is in place', command: 'sudo bash tools/shape.sh status', note: 'Lists the pipes and rules still loaded.' },
      { title: 'Turn it off again', command: 'sudo bash tools/shape.sh off', note: 'Always do this when you are done, or loopback stays slow.' },
    ],
  },
  'lab-certs': {
    id: 'lab-certs', label: 'Make the transport-lab certificates', kind: 'guide', safety: 'safe',
    summary: 'Makes the certificate the lab proxy serves with mkcert and prints the hash Chrome trusts. Nothing is added to the system trust store.',
    params: [], stages: [],
    guide: [{ title: 'Make the certificates', command: 'bash tools/lab-certs.sh', note: 'Needs mkcert installed.' }],
  },
  'chrome-lab': {
    id: 'chrome-lab', label: 'Launch Chrome for the transport lab', kind: 'guide', safety: 'safe',
    summary: 'Opens Chrome with a throwaway profile that forces h3 on localhost:8443 and trusts the lab certificate for that profile only.',
    params: [], stages: [],
    guide: [{ title: 'Launch Chrome', command: 'bash tools/chrome-lab.sh http://localhost:5173/', note: 'Run the certificates step first. A fresh profile every run, so no QUIC state leaks between runs.' }],
  },
}

export const isWorkflowId = (value: unknown): value is WorkflowId => typeof value === 'string' && Object.hasOwn(WORKFLOWS, value)

const TARGET_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/

type Checked = { ok: true; value: ParamValue } | { ok: false; error: string }

function checkOne(type: Exclude<ParamType, { kind: 'list' }>, value: unknown): Checked {
  if (type.kind === 'target') {
    const bad = { ok: false, error: 'must be name=base URL, e.g. local=http://localhost:8788' } as const
    if (typeof value !== 'string') return bad
    const i = value.indexOf('=')
    if (i < 1 || !TARGET_NAME.test(value.slice(0, i))) return bad
    const base = validateField({ key: '', label: '', help: '', type: { kind: 'url' } }, value.slice(i + 1))
    return base.ok ? { ok: true, value: `${value.slice(0, i)}=${base.value}` } : bad
  }
  return validateField({ key: '', label: '', help: '', type }, value)
}

function check(type: ParamType, value: unknown): Checked {
  if (type.kind !== 'list') return checkOne(type, value)
  if (!Array.isArray(value)) return { ok: false, error: 'must be a list' }
  if (value.length < type.min || value.length > type.max) return { ok: false, error: `must have ${type.min === type.max ? type.min : `${type.min} to ${type.max}`} items` }
  const out: string[] = []
  for (const [n, item] of value.entries()) {
    const r = checkOne(type.item, item)
    if (!r.ok) return { ok: false, error: `item ${n + 1} ${r.error}` }
    out.push(String(r.value))
  }
  return { ok: true, value: out }
}

export type ParamsResult = { ok: true; params: Params } | { ok: false; errors: Record<string, string> }

/**
 * Checks the parameters of a run as sent to the API. Unknown parameters are errors. A missing parameter takes the
 * workflow's default, then the caller's `defaults` (the server supplies `bucket` from S3_BUCKET); a required one still
 * missing is an error. A guide is never runnable.
 */
export function validateParams(id: WorkflowId, input: unknown, defaults: Params = {}): ParamsResult {
  const wf = WORKFLOWS[id]
  if (wf.kind !== 'run') return { ok: false, errors: { '': `${wf.label} is a guide and cannot be run` } }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: { '': 'must be an object of parameters' } }
  const given = new Map(Object.entries(input))
  const params: [string, ParamValue][] = []
  // Entries, not assignment into an object: a key of `__proto__` would hit the prototype setter and vanish.
  const errors: [string, string][] = []
  for (const key of given.keys()) if (!wf.params.some((p) => p.key === key)) errors.push([key, 'unknown parameter'])
  for (const p of wf.params) {
    const raw = given.get(p.key)
    if (raw === undefined || raw === null || raw === '') {
      const fallback = p.default ?? defaults[p.key]
      if (fallback !== undefined) params.push([p.key, fallback])
      else if (p.required) errors.push([p.key, 'is required'])
      continue
    }
    const r = check(p.type, raw)
    if (r.ok) params.push([p.key, r.value])
    else errors.push([p.key, r.error])
  }
  return errors.length ? { ok: false, errors: Object.fromEntries(errors) } : { ok: true, params: Object.fromEntries(params) }
}

/** The stages a run of `id` with these (validated) params will go through: for a gated workflow, the dry run unless it confirms one. */
export function stagesFor(id: WorkflowId, params: Params): readonly StageDef[] {
  const wf = WORKFLOWS[id]
  return wf.safety === 'dry-run-then-confirm' && !params.confirm ? (wf.dryRunStages ?? []) : wf.stages
}

/** True when a validated run is the dry run of a gated workflow. */
export const isDryRun = (id: WorkflowId, params: Params): boolean => WORKFLOWS[id].safety === 'dry-run-then-confirm' && !params.confirm

// --- what the API serves ---------------------------------------------------------------------------------------------

type JsonType = Exclude<ParamType, { kind: 'text' }> | { kind: 'text'; pattern: string; hint: string }
export interface WorkflowInfo extends Omit<Workflow, 'params'> {
  params: (Omit<Param, 'type'> & { type: JsonType | { kind: 'list'; item: JsonType; min: number; max: number } })[]
  /** False for a workflow the server cannot run (a guide, or one this server has no implementation of). */
  runnable: boolean
}

const jsonType = (t: ParamType): JsonType | { kind: 'list'; item: JsonType; min: number; max: number } =>
  t.kind === 'list' ? { ...t, item: jsonType(t.item) as JsonType } : t.kind === 'text' ? { ...t, pattern: t.pattern.source } : t

/** A workflow as JSON (a RegExp does not survive JSON.stringify), for `GET /workflows`. */
export function describeWorkflow(wf: Workflow, runnable: boolean): WorkflowInfo {
  return { ...wf, params: wf.params.map((p) => ({ ...p, type: jsonType(p.type) })), runnable: runnable && wf.kind === 'run' }
}
