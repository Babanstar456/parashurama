// Behaviour trees: the threat AI's decision structure. A tree is ticked once per simulation step for each drone.
//  - selector: tries its children in order and stops at the first that does not fail ("do the first that applies")
//  - sequence: runs its children in order and stops at the first that does not succeed ("all of these, in order")
//  - condition: succeeds or fails, changes nothing
//  - action: changes the world; succeeds unless it says otherwise
// Pure and deterministic: no clock and no random numbers of its own (randomness comes from the engine's seeded streams),
// so a drill is still fully defined by its seed and its decision log.

export type Status = 'success' | 'failure' | 'running';
export interface BTNode<C> { readonly name: string; readonly kind: 'selector' | 'sequence' | 'condition' | 'action'; readonly children?: readonly BTNode<C>[]; tick(ctx: C): Status; }

export function selector<C>(name: string, ...children: BTNode<C>[]): BTNode<C> {
  return { name, kind: 'selector', children, tick(ctx) { for (const k of children) { const s = k.tick(ctx); if (s !== 'failure') return s; } return 'failure'; } };
}
export function sequence<C>(name: string, ...children: BTNode<C>[]): BTNode<C> {
  return { name, kind: 'sequence', children, tick(ctx) { for (const k of children) { const s = k.tick(ctx); if (s !== 'success') return s; } return 'success'; } };
}
export function condition<C>(name: string, test: (ctx: C) => boolean): BTNode<C> {
  return { name, kind: 'condition', tick: (ctx) => (test(ctx) ? 'success' : 'failure') };
}
export function action<C>(name: string, run: (ctx: C) => Status | void): BTNode<C> {
  return { name, kind: 'action', tick: (ctx) => (run(ctx) as Status | undefined) ?? 'success' };
}

/** The tree as indented text (for documentation and the instructor's view of the threat AI). */
export function describeTree<C>(n: BTNode<C>, depth = 0): string {
  const mark = { selector: '?', sequence: '→', condition: '◇', action: '■' }[n.kind];
  return [`${'  '.repeat(depth)}${mark} ${n.name}`, ...(n.children ?? []).map((k) => describeTree(k, depth + 1))].join('\n');
}
