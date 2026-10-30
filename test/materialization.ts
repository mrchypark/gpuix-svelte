import assert from 'node:assert/strict';
import renderer, { commit, create_root, set_native } from '../src/renderer.ts';
import type { Mutation, ShadowNode } from '../src/types.ts';

// Replay structural mutations without loading native or using a GPU.
function setup() {
	const children = new Map<number, number[]>();
	const parents = new Map<number, number>();
	const ops: Mutation[] = [];
	set_native({
		applyBatch(json) {
			const batch: Mutation[] = JSON.parse(json);
			ops.push(...batch);
			for (const op of batch) {
				if (op[0] === 'createElement') {
					assert.equal(children.has(op[1]), false);
					children.set(op[1], []);
				} else if (op[0] === 'appendChild' || op[0] === 'insertBefore') {
					assert.ok(children.has(op[2]));
					const old_parent = parents.get(op[2]);
					if (old_parent !== undefined) {
						const siblings = children.get(old_parent)!;
						siblings.splice(siblings.indexOf(op[2]), 1);
					}
					parents.set(op[2], op[1]);
					const siblings = children.get(op[1])!;
					assert.ok(siblings);
					if (op[0] === 'appendChild') siblings.push(op[2]);
					else {
						const index = siblings.indexOf(op[3]);
						assert.notEqual(index, -1);
						siblings.splice(index, 0, op[2]);
					}
				}
			}
			return [];
		}
	});
	const root = create_root();
	return {
		root,
		ops,
		order(parent: ShadowNode, expected: ShadowNode[]) {
			commit();
			assert.deepEqual(children.get(parent.nativeId!), expected.map((n) => n.nativeId));
		}
	};
}

for (const count of [100, 1_000, 10_000]) {
	let next_reads = 0;
	const parent = renderer.createElement('div');
	const nodes: ShadowNode[] = [];
	for (let i = 0; i < count; i++) {
		const child = renderer.createElement('div');
		let next: ShadowNode | null = null;
		Object.defineProperty(child, 'next', {
			get: () => (next_reads++, next),
			set: (value: ShadowNode | null) => { next = value; }
		});
		renderer.insert(parent, child, null);
		nodes.push(child);
	}
	const { root, ops } = setup();
	next_reads = 0;
	renderer.insert(root, parent, null);
	// Count work rather than wall time, so CPU speed and native startup cannot hide a regression.
	assert.ok(next_reads <= 3 * count, `${count} children: ${next_reads} next reads`);
	commit();
	assert.equal(ops.filter((op) => op[0] === 'createElement').length, count + 2);
	assert.deepEqual(ops.filter((op) => op[0] === 'appendChild' && op[1] === parent.nativeId),
		nodes.map((n) => ['appendChild', parent.nativeId, n.nativeId]));
	assert.ok(nodes.every((n) => n.live && n.attached));
	console.log(`${count} disconnected children: ${next_reads} next reads`);
}

{
	const { root, order } = setup();
	const parent = renderer.createElement('div');
	const a = renderer.createTextNode('a');
	const b = renderer.createTextNode('b');
	const c = renderer.createTextNode('c');
	const comment = renderer.createComment('anchor');
	const blank = renderer.createTextNode('');
	const fragment = renderer.createFragment();
	const portal = renderer.createElement('div');
	const nested_portal = renderer.createElement('div');
	renderer.setAttribute(portal, 'portal', '');
	renderer.setAttribute(nested_portal, 'portal', '');
	renderer.insert(portal, nested_portal, null);
	for (const n of [a, comment, blank, portal, b, c]) renderer.insert(fragment, n, null);
	renderer.insert(parent, fragment, null);
	assert.equal(a.nativeId, null);
	renderer.insert(root, parent, null);
	order(parent, [a, b, c]);
	order(root, [parent, nested_portal, portal]);
	assert.equal(comment.nativeId, null);
	assert.equal(blank.nativeId, null);
	assert.equal(fragment.first, null);

	renderer.insert(parent, c, comment);
	order(parent, [a, c, b]);
	renderer.setText(blank, 'was blank');
	order(parent, [a, c, blank, b]);
	renderer.insert(parent, b, a);
	order(parent, [b, a, c, blank]);
	renderer.remove(c);
	renderer.insert(parent, c, blank);
	order(parent, [b, a, c, blank]);
	// Re-enter materialize() on an existing parent: its native children must keep their order.
	renderer.remove(parent);
	const parked = renderer.createTextNode('added while disconnected');
	renderer.insert(parent, parked, c);
	renderer.insert(root, parent, null);
	order(parent, [b, a, parked, c, blank]);
	order(root, [nested_portal, portal, parent]);
}

console.log('materialization: passed');
