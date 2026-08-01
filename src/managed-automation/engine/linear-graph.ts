export type LinearGraphFailure =
  | 'empty_graph'
  | 'duplicate_node_id'
  | 'edge_references_unknown_node'
  | 'multiple_incoming_edges'
  | 'multiple_outgoing_edges'
  | 'no_unique_entry_node'
  | 'graph_not_single_chain';

export type LinearGraphResult =
  | { ok: true; order: string[] }
  | { ok: false; reason: LinearGraphFailure; detail: string };

export function resolveLinearGraph(
  nodeIds: readonly string[],
  edges: readonly { from: string; to: string }[],
): LinearGraphResult {
  if (nodeIds.length === 0) {
    return { ok: false, reason: 'empty_graph', detail: 'execution graph has no nodes' };
  }
  const nodes = new Set<string>();
  for (const nodeId of nodeIds) {
    if (nodes.has(nodeId)) {
      return { ok: false, reason: 'duplicate_node_id', detail: `duplicate node ${nodeId}` };
    }
    nodes.add(nodeId);
  }

  const outgoing = new Map<string, string>();
  const incoming = new Set<string>();
  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      return {
        ok: false,
        reason: 'edge_references_unknown_node',
        detail: `edge ${edge.from}->${edge.to} references an unknown node`,
      };
    }
    if (outgoing.has(edge.from)) {
      return { ok: false, reason: 'multiple_outgoing_edges', detail: `node ${edge.from} has multiple outgoing edges` };
    }
    if (incoming.has(edge.to)) {
      return { ok: false, reason: 'multiple_incoming_edges', detail: `node ${edge.to} has multiple incoming edges` };
    }
    outgoing.set(edge.from, edge.to);
    incoming.add(edge.to);
  }

  const entries = [...nodes].filter((nodeId) => !incoming.has(nodeId));
  if (entries.length !== 1) {
    return {
      ok: false,
      reason: 'no_unique_entry_node',
      detail: `expected one entry node, found ${entries.length}`,
    };
  }

  const order: string[] = [];
  let cursor: string | undefined = entries[0];
  while (cursor !== undefined && order.length <= nodes.size) {
    order.push(cursor);
    cursor = outgoing.get(cursor);
  }
  if (order.length !== nodes.size || edges.length !== nodes.size - 1) {
    return {
      ok: false,
      reason: 'graph_not_single_chain',
      detail: `entry reaches ${order.length}/${nodes.size} nodes with ${edges.length} edges`,
    };
  }
  return { ok: true, order };
}

