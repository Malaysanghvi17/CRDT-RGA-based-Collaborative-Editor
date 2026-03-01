import { CRDTID, CRDTNode } from "../models/crdt.models";

export class CRDT {
    private PendingQueue: Array<{ parent: CRDTID, node: CRDTNode }> = [];
    private PendingDeleteQueue: Array<CRDTID> = [];

    private idToNode: Map<string, CRDTNode> = new Map();

    private UserId: string;
    private localSeq: number = 0;
    private RootCrdtId: CRDTID;

    constructor(userid: string) {
        this.UserId = userid;
        this.RootCrdtId = new CRDTID("ROOT", 0);
        let rootNode = new CRDTNode(this.RootCrdtId, "", null, null, false);
        this.idToNode.set(rootNode.id.toString(), rootNode);
        this.localSeq = 1;
    }

    InsertAfterIndex(index: number, value: string): CRDTNode | undefined {
        // 1. Find the node currently at 'index' to act as the parent
        // If index is -1, we insert after ROOT. 
        // If index is 0, we insert after the first visible char.
        let ParentNode: CRDTNode | null;

        if (index < 0) {
            ParentNode = this.idToNode.get(this.RootCrdtId.toString())!;
        } else {
            ParentNode = this.findNodeAtVisibleIndex(index);
        }

        if (!ParentNode) {
            console.error(`Index ${index} out of bounds`);
            return;
        }

        let NewNodeId = new CRDTID(this.UserId, this.localSeq++);
        let NewNode = new CRDTNode(NewNodeId, value, null, ParentNode.id, false);

        this.IntegrateNode(NewNode, ParentNode.id);
        return NewNode;
    }

    DeleteAtIndex(index: number): CRDTID | undefined {
        let Node = this.findNodeAtVisibleIndex(index);
        if (!Node) {
            console.error(`Delete: Index ${index} out of bounds`);
            return;
        }
        return this.DeleteCrdtNode(Node.id);
    }

    DocumentReconciliation(): string {
        // console.log(this.getVisualStructure());
        let document = "";
        let curr: CRDTNode | undefined | null = this.idToNode.get(this.RootCrdtId.toString());

        while (curr) {
            if (!curr.is_deleted && curr.id !== this.RootCrdtId) {
                document += curr.value;
            }
            if (!curr.next) break;
            curr = this.idToNode.get(curr.next.toString());
        }
        return document;
    }

    MergeRemoteNode(nodeData: any) {
        const id = new CRDTID(nodeData.id.id, nodeData.id.seq);
        const parentId = nodeData.parent ? new CRDTID(nodeData.parent.id, nodeData.parent.seq) : null;

        // Lamport clock synchronization
        this.localSeq = Math.max(this.localSeq, id.seq) + 1;

        const node = new CRDTNode(
            id,
            nodeData.value,
            null, // Next is recalculated during insert
            parentId,
            nodeData.is_deleted
        );

        if (node.is_deleted) {
            // If we receive a delete for a node we don't have yet, queue it
            if (!this.idToNode.has(node.id.toString())) {
                this.PendingDeleteQueue.push(node.id);
                // We also need to insert the node itself (as deleted) so the chain isn't broken
                if (node.parent) this.IntegrateNode(node, node.parent);
            } else {
                this.DeleteCrdtNode(node.id);
            }
        } else {
            if (node.parent) {
                this.IntegrateNode(node, node.parent);
            }
        }

        this.processPending();
    }

    MergeRemoteDelete(targetIdData: any) {
        const targetId = new CRDTID(targetIdData.id, targetIdData.seq);

        // Lamport clock synchronization
        this.localSeq = Math.max(this.localSeq, targetId.seq) + 1;

        this.DeleteCrdtNode(targetId);
    }

    private IntegrateNode(node: CRDTNode, parentId: CRDTID) {
        if (this.idToNode.has(node.id.toString())) return;

        const parentNode = this.idToNode.get(parentId.toString());
        if (!parentNode) {
            this.PendingQueue.push({ parent: parentId, node: node });
            return;
        }

        // RGA INSERT ALGORITHM (Strict Tree Traversal)
        let prev = parentNode;
        while (prev.next) {
            const nextNode = this.idToNode.get(prev.next.toString());
            if (!nextNode) break;

            if (this.isDescendant(nextNode.id, parentNode.id)) {
                // If nextNode is a direct sibling of the new node N
                const isSibling = nextNode.parent?.toString() === parentNode.id.toString();

                if (isSibling) {
                    if (nextNode.id.compareTo(node.id) > 0) {
                        prev = nextNode; // Skip this sibling (and subsequently its descendants)
                    } else {
                        break; // Stop here! N has higher priority.
                    }
                } else {
                    // It's a descendant of a sibling we just decided to skip.
                    prev = nextNode;
                }
            } else {
                // Not a descendant of the parent. We've reached the end of the parent's subtree.
                break;
            }
        }

        node.next = prev.next;
        prev.next = node.id;

        this.idToNode.set(node.id.toString(), node);

        // Check if this node was waiting to be deleted
        this.checkPendingDeletes(node.id);
    }

    private isDescendant(nodeId: CRDTID, ancestorId: CRDTID): boolean {
        let curr = this.idToNode.get(nodeId.toString());
        while (curr && curr.parent) {
            if (curr.parent.toString() === ancestorId.toString()) return true;
            curr = this.idToNode.get(curr.parent.toString());
        }
        return false;
    }

    private DeleteCrdtNode(id: CRDTID): CRDTID | undefined {
        const node = this.idToNode.get(id.toString());
        if (!node) {
            this.PendingDeleteQueue.push(id);
            return;
        }
        node.is_deleted = true;
        return node.id;
    }

    private findNodeAtVisibleIndex(index: number): CRDTNode | null {
        let curr = this.idToNode.get(this.RootCrdtId.toString());
        let visibleIndex = -1;
        while (curr) {
            if (!curr.is_deleted && curr.id !== this.RootCrdtId) {
                visibleIndex++;
            }
            if (visibleIndex === index) return curr;
            if (!curr.next) break;
            curr = this.idToNode.get(curr.next.toString());
        }
        return null;
    }

    getAnchorAtVisibleIndex(index: number): CRDTID | null {
        if (index < 0) return this.RootCrdtId;
        const node = this.findNodeAtVisibleIndex(index);
        return node ? node.id : null;
    }

    getVisibleIndexFromAnchor(anchorId: CRDTID | null): number {
        if (!anchorId) return -1;
        if (anchorId.toString() === this.RootCrdtId.toString()) return -1;
        let curr = this.idToNode.get(this.RootCrdtId.toString());
        let visibleIndex = -1;
        while (curr) {
            if (!curr.is_deleted && curr.id !== this.RootCrdtId) {
                visibleIndex++;
            }
            if (curr.id.toString() === anchorId.toString()) {
                return visibleIndex;
            }
            if (!curr.next) break;
            curr = this.idToNode.get(curr.next.toString());
        }
        return -1;
    }

    private processPending() {
        let remaining: typeof this.PendingQueue = [];
        let processed = false;

        for (const item of this.PendingQueue) {
            if (this.idToNode.has(item.parent.toString())) {
                this.IntegrateNode(item.node, item.parent);
                processed = true;
            } else {
                remaining.push(item);
            }
        }
        this.PendingQueue = remaining;
        if (processed && this.PendingQueue.length > 0) this.processPending(); // Retry others
    }

    private checkPendingDeletes(id: CRDTID) {
        const idStr = id.toString();
        const idx = this.PendingDeleteQueue.findIndex(d => d.toString() === idStr);
        if (idx !== -1) {
            this.DeleteCrdtNode(id);
            this.PendingDeleteQueue.splice(idx, 1);
        }
    }

    // For Debugging
    public getVisualStructure(): string {
        let lines: string[] = [];
        let curr = this.idToNode.get(this.RootCrdtId.toString());

        while (curr) {
            const deletedMark = curr.is_deleted ? " (DELETED)" : "";
            lines.push(`[${curr.id}] "${curr.value}"${deletedMark}`);

            if (!curr.next) break;
            lines.push("   ↓");
            curr = this.idToNode.get(curr.next.toString());
        }

        return lines.join("\n");
    }

}