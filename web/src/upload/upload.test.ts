import { describe, expect, it } from 'vitest'
import { readLaunch } from '../launch'
import { activeStageId, describeStage, formatBytes, formatDuration, stageElapsed } from './format'
import { COL_GAP, NODE_H, NODE_W, layoutGraph } from './graph-layout'
import type { Stage } from './types'

const linear = ['upload', 'probe', 'validate'].map((id, i, all) => ({ id, needs: i ? [all[i - 1]] : [] }))
const diamond = [
  { id: 'a', needs: [] },
  { id: 'b', needs: ['a'] },
  { id: 'c', needs: ['a'] },
  { id: 'd', needs: ['b', 'c'] },
]
const stage = (over: Partial<Stage>): Stage => ({
  id: 's', label: 'Probe', needs: [], status: 'queued', startedAt: null, endedAt: null, progress: null, summary: null, result: null, log: [], ...over,
})

describe('layoutGraph', () => {
  it('puts a linear pipeline in one row, a column per stage', () => {
    const l = layoutGraph(linear)
    expect(l.nodes.map((n) => [n.col, n.row, n.y])).toEqual([[0, 0, 0], [1, 0, 0], [2, 0, 0]])
    expect(l.nodes[1].x).toBe(NODE_W + COL_GAP)
    expect(l.width).toBe(3 * NODE_W + 2 * COL_GAP)
    expect(l.height).toBe(NODE_H)
    expect(l.edges.map((e) => [e.from, e.to])).toEqual([['upload', 'probe'], ['probe', 'validate']])
  })

  it('puts parallel stages in the same column and centres the lone ones', () => {
    const l = layoutGraph(diamond)
    const at = Object.fromEntries(l.nodes.map((n) => [n.id, n]))
    expect([at.b.col, at.c.col]).toEqual([1, 1])
    expect([at.b.row, at.c.row]).toEqual([0, 1])
    expect(at.d.col).toBe(2)
    // a and d sit halfway between the two rows of b and c.
    expect(at.a.y).toBe(at.d.y)
    expect(at.a.y).toBe((at.b.y + at.c.y) / 2)
    expect(l.edges).toHaveLength(4)
  })

  it('uses the longest chain for the column, and an edge may skip columns', () => {
    const l = layoutGraph([
      { id: 'a', needs: [] },
      { id: 'b', needs: ['a'] },
      { id: 'c', needs: ['a', 'b'] },
    ])
    expect(l.nodes.find((n) => n.id === 'c')?.col).toBe(2)
    expect(l.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['a>b', 'a>c', 'b>c'])
  })

  it('ignores unknown dependencies and survives a cycle', () => {
    expect(layoutGraph([{ id: 'a', needs: ['ghost'] }]).nodes[0].col).toBe(0)
    expect(() => layoutGraph([{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['a'] }])).not.toThrow()
  })

  it('handles an empty graph', () => {
    expect(layoutGraph([])).toMatchObject({ nodes: [], edges: [] })
  })

  it('draws each edge from the right edge of one node to the left edge of the next', () => {
    const [e] = layoutGraph(linear).edges
    expect(e.d.startsWith(`M${NODE_W} ${NODE_H / 2} C`)).toBe(true)
    expect(e.d.endsWith(`${NODE_W + COL_GAP} ${NODE_H / 2}`)).toBe(true)
  })
})

describe('formatting', () => {
  it('formats durations and sizes', () => {
    expect(formatDuration(240)).toBe('240 ms')
    expect(formatDuration(1500)).toBe('1.5 s')
    expect(formatDuration(125_000)).toBe('2 m 5 s')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2_500_000)).toBe('2.5 MB')
    expect(formatBytes(3_200_000_000)).toBe('3.20 GB')
  })

  it('times a stage: final, live while running, none if it never started', () => {
    expect(stageElapsed(stage({ status: 'success', startedAt: 100, endedAt: 400 }), 9999)).toBe(300)
    expect(stageElapsed(stage({ status: 'running', startedAt: 100 }), 600)).toBe(500)
    expect(stageElapsed(stage({ status: 'skipped' }), 600)).toBeNull()
    expect(stageElapsed(stage({ status: 'queued' }), 600)).toBeNull()
  })

  it('describes a node for screen readers', () => {
    expect(describeStage(stage({ status: 'success', startedAt: 0, endedAt: 300 }), 0)).toBe('Probe: succeeded in 300 ms')
    expect(describeStage(stage({ status: 'running', startedAt: 0, progress: 0.42 }), 2000)).toBe('Probe: running in 2.0 s, 42%')
    expect(describeStage(stage({ status: 'skipped' }), 0)).toBe('Probe: skipped')
  })

  it('picks the stage worth showing', () => {
    const s = (...statuses: Stage['status'][]) => statuses.map((status, i) => ({ id: `s${i}`, status }))
    expect(activeStageId(s('success', 'running', 'queued'))).toBe('s1')
    expect(activeStageId(s('success', 'failed', 'skipped'))).toBe('s1')
    expect(activeStageId(s('success', 'cached', 'success'))).toBe('s2')
    expect(activeStageId(s('queued', 'queued'))).toBe('s0')
    expect(activeStageId([])).toBeNull()
  })
})

describe('readLaunch', () => {
  it('reads a delivery and stream id', () => {
    expect(readLaunch('?delivery=local&stream=ugc-demo-hls')).toEqual({ delivery: 'local', stream: 'ugc-demo-hls' })
  })

  it('ignores anything that is not a known delivery or a safe id', () => {
    expect(readLaunch('?delivery=bogus&stream=../x')).toEqual({})
    expect(readLaunch('?stream=<script>')).toEqual({})
    expect(readLaunch('')).toEqual({})
  })
})
