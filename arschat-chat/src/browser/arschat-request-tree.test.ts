import { removeRequestFromModel, BranchLike, RequestTreeModel } from './arschat-request-tree';

// Build a linear chain of single-item branches (id0 -> id1 -> id2 ...), mirroring
// how ChatRequestHierarchyImpl links turns, and expose getBranch()/root so we can
// assert the surviving active path after a removal.
function buildChain(ids: string[]): { model: RequestTreeModel; root: BranchLike | undefined } {
    let root: BranchLike | undefined;
    let prev: BranchLike | undefined;
    const byId = new Map<string, BranchLike>();
    for (const id of ids) {
        const branch: BranchLike = {
            items: [{ element: { id } }],
            activeBranchIndex: 0,
            previous: prev,
            hierarchy: undefined
        };
        byId.set(id, branch);
        if (!root) {
            root = branch;
        }
        if (prev) {
            prev.items[prev.activeBranchIndex].next = branch;
        }
        prev = branch;
    }
    // Share a single hierarchy holder so root reassignment is observable.
    const holder = { branch: root as BranchLike };
    for (const b of byId.values()) {
        b.hierarchy = holder;
    }
    const model: RequestTreeModel = {
        getBranch: (requestId: string) => {
            // findBranch semantics: the branch whose items contain the id.
            for (const b of byId.values()) {
                if (b.items.some(it => it.element.id === requestId)) {
                    return b;
                }
            }
            return undefined;
        }
    };
    return { model, root: holder.branch };
}

/** Walk the active path from a root branch, like ChatRequestHierarchyImpl.iterateBranches. */
function activeIds(root: BranchLike | undefined): string[] {
    const out: string[] = [];
    let current: BranchLike | undefined = root;
    while (current && current.items.length > 0) {
        const item = current.items[current.activeBranchIndex];
        out.push(item.element.id);
        current = item.next;
    }
    return out;
}

describe('removeRequestFromModel', () => {

    it('removes a middle turn and keeps the surrounding turns linked', () => {
        const { model } = buildChain(['a', 'b', 'c']);
        const holder = (model.getBranch('a') as BranchLike).hierarchy!;
        expect(removeRequestFromModel(model, 'b')).toBe(true);
        expect(activeIds(holder.branch)).toEqual(['a', 'c']);
    });

    it('removes the last turn', () => {
        const { model } = buildChain(['a', 'b', 'c']);
        const holder = (model.getBranch('a') as BranchLike).hierarchy!;
        expect(removeRequestFromModel(model, 'c')).toBe(true);
        expect(activeIds(holder.branch)).toEqual(['a', 'b']);
    });

    it('removes the root turn by promoting the next branch to root', () => {
        const { model } = buildChain(['a', 'b', 'c']);
        const holder = (model.getBranch('a') as BranchLike).hierarchy!;
        expect(removeRequestFromModel(model, 'a')).toBe(true);
        expect(activeIds(holder.branch)).toEqual(['b', 'c']);
        expect(holder.branch.previous).toBeUndefined();
    });

    it('empties the tree when the only turn is removed', () => {
        const { model } = buildChain(['solo']);
        const holder = (model.getBranch('solo') as BranchLike).hierarchy!;
        expect(removeRequestFromModel(model, 'solo')).toBe(true);
        expect(activeIds(holder.branch)).toEqual([]);
    });

    it('drops only the selected version from a branch with alternatives', () => {
        const branch: BranchLike = {
            items: [{ element: { id: 'v1' } }, { element: { id: 'v2' } }],
            activeBranchIndex: 1
        };
        const model: RequestTreeModel = { getBranch: id => (branch.items.some(it => it.element.id === id) ? branch : undefined) };
        expect(removeRequestFromModel(model, 'v1')).toBe(true);
        expect(branch.items.map(it => it.element.id)).toEqual(['v2']);
        // active index shifts down so it still points at v2
        expect(branch.activeBranchIndex).toBe(0);
    });

    it('is a no-op for an unknown request id', () => {
        const { model } = buildChain(['a', 'b']);
        const holder = (model.getBranch('a') as BranchLike).hierarchy!;
        expect(removeRequestFromModel(model, 'zzz')).toBe(false);
        expect(activeIds(holder.branch)).toEqual(['a', 'b']);
    });
});
