// *****************************************************************************
// ArsChat request-tree surgery (M6 e-24).
//
// Theia's ai-chat ChatModel is append-only: MutableChatModel exposes addRequest
// but no removeRequest. A "turn" is a single ChatRequestModel that carries BOTH
// the user request and the assistant response, and turns are stored in a linked
// list of "branches" (ChatRequestHierarchyImpl): each branch holds one or more
// alternative versions (`items`), the active version points to the next branch
// via `item.next`, and `hierarchy.branch` is the root.
//
// To implement the hover "削除" (delete) / "再生成" (regenerate) actions we must
// remove one turn and keep the remaining turns reachable. We do that here purely
// against the (documented) hierarchy shape read from chat-model.js, so the widget
// stays free of casts and the logic is unit-testable against a structural fake.
// After removal the caller persists the mutated model with
// ChatSessionStore.storeSessions(model); serialization walks the same links, so a
// re-linked tree round-trips without the deleted turn.
// *****************************************************************************

/** One alternative version of a turn within a branch. `next` is the branch that follows it. */
export interface BranchItemLike {
    readonly element: { readonly id: string };
    next?: BranchLike;
}

/** A node in the linked list of turns. Mirrors ChatRequestHierarchyBranchImpl. */
export interface BranchLike {
    readonly items: BranchItemLike[];
    activeBranchIndex: number;
    previous?: BranchLike;
    /** Present on real branches; used only to reassign the root when the first turn is deleted. */
    hierarchy?: { branch: BranchLike };
}

/** The subset of MutableChatModel we need. */
export interface RequestTreeModel {
    getBranch(requestId: string): BranchLike | undefined;
}

/**
 * Remove the turn identified by `requestId` from the model's request hierarchy,
 * re-linking the chain so preceding and following turns stay reachable.
 *
 * Handles every position:
 *  - a versioned branch (multiple `items`): drops just that version;
 *  - a middle/last single-item branch: unlinks it and points the previous active
 *    item at the branch that followed;
 *  - the root turn: promotes the following branch to root, or empties the tree if
 *    it was the only turn.
 *
 * Returns true if a turn was removed. Safe to call with an unknown id (no-op).
 */
export function removeRequestFromModel(model: RequestTreeModel, requestId: string): boolean {
    const branch = model.getBranch(requestId);
    if (!branch) {
        return false;
    }
    const idx = branch.items.findIndex(it => it.element.id === requestId);
    if (idx < 0) {
        return false;
    }

    // Alternative versions coexist in this branch: drop only the selected version.
    if (branch.items.length > 1) {
        branch.items.splice(idx, 1);
        if (branch.activeBranchIndex >= idx && branch.activeBranchIndex > 0) {
            branch.activeBranchIndex--;
        }
        return true;
    }

    // Single-item branch: unlink the whole branch from the linked list.
    const removedNext = branch.items[idx].next;
    const prev = branch.previous;
    if (prev) {
        const prevActive = prev.items[prev.activeBranchIndex];
        if (prevActive) {
            prevActive.next = removedNext;
        }
        if (removedNext) {
            removedNext.previous = prev;
        }
        return true;
    }

    // No previous branch => the deleted turn is the root.
    if (removedNext && branch.hierarchy) {
        removedNext.previous = undefined;
        branch.hierarchy.branch = removedNext;
    } else {
        // Only turn in the session: leave an empty root branch (iterateBranches
        // stops on an empty branch, so getRequests() correctly returns []).
        branch.items.splice(0, branch.items.length);
        branch.activeBranchIndex = -1;
    }
    return true;
}
