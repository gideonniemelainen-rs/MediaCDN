// Layout for the workflow graph: a stage's column is its longest dependency chain, so a linear
// pipeline is one row and a fan-out puts parallel stages in the same column. Pure, so it is tested
// without a DOM.

export const NODE_W = 158
export const NODE_H = 58
export const COL_GAP = 44
export const ROW_GAP = 14

export interface LayoutNode { id: string; col: number; row: number; x: number; y: number }
export interface LayoutEdge { from: string; to: string; d: string }
export interface Layout { nodes: LayoutNode[]; edges: LayoutEdge[]; width: number; height: number }

export function layoutGraph(stages: { id: string; needs: string[] }[]): Layout {
  const byId = new Map(stages.map((s) => [s.id, s]))
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const colOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    // A cycle (which the server never sends) must not recurse forever.
    if (visiting.has(id)) return 0
    visiting.add(id)
    const needs = (byId.get(id)?.needs ?? []).filter((n) => byId.has(n))
    const col = needs.length ? 1 + Math.max(...needs.map(colOf)) : 0
    visiting.delete(id)
    depth.set(id, col)
    return col
  }

  const rowsInCol = new Map<number, number>()
  const placed = stages.map((s) => {
    const col = colOf(s.id)
    const row = rowsInCol.get(col) ?? 0
    rowsInCol.set(col, row + 1)
    return { id: s.id, col, row }
  })

  const cols = Math.max(0, ...rowsInCol.keys()) + 1
  const tallest = Math.max(1, ...rowsInCol.values())
  const step = NODE_H + ROW_GAP
  const nodes = placed.map(({ id, col, row }) => ({
    id,
    col,
    row,
    x: col * (NODE_W + COL_GAP),
    // Shorter columns are centred against the tallest one.
    y: ((tallest - (rowsInCol.get(col) ?? 1)) / 2 + row) * step,
  }))

  const at = new Map(nodes.map((n) => [n.id, n]))
  const edges: LayoutEdge[] = []
  for (const s of stages) {
    for (const need of s.needs) {
      const a = at.get(need)
      const b = at.get(s.id)
      if (!a || !b) continue
      const x1 = a.x + NODE_W
      const y1 = a.y + NODE_H / 2
      const x2 = b.x
      const y2 = b.y + NODE_H / 2
      const dx = (x2 - x1) / 2
      edges.push({ from: need, to: s.id, d: `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}` })
    }
  }

  return { nodes, edges, width: cols * NODE_W + (cols - 1) * COL_GAP, height: tallest * NODE_H + (tallest - 1) * ROW_GAP }
}
