import { CRDT } from "./crdt.service";
import { WebSocketService } from "./websocket.service";
import { type SharedCursorPosition } from "../utils/cursor.utils";

export interface EditorOperation {
    type:
    | "insert" | "delete" | "cursor" | "cursor_remove"
    | "load_document" | "save_document"
    | "create_document" | "get_documents" | "delete_document" | "rename_document";
    node?: any;
    targetId?: any;
    userId?: string;
    position?: SharedCursorPosition;
    documentId?: string;
    documents?: any[];
}

/**
 * EditorService — Bridge between textarea and CRDT.
 *
 * ## Offline / reconnect behaviour
 *
 * While offline, ops typed by the user are:
 *   1. Applied to the local CRDT immediately (so the editor stays responsive).
 *   2. Queued in WebSocketService.outgoingQueue for later delivery.
 *
 * On reconnect:
 *   - We do NOT reset the CRDT. The local state already includes the user's
 *     offline edits.
 *   - We send `load_document` with `lastSeq` = the last sequence number we
 *     acknowledged from the server.
 *   - The server replays only ops with seq > lastSeq (ops from other peers
 *     we missed while offline).
 *   - Our queued offline ops are flushed by WebSocketService right after
 *     reconnection and are appended to the server log normally.
 *   - Because CRDT ops are commutative and idempotent, merging the missed
 *     remote ops on top of our existing local state converges correctly.
 *
 * ## Message protocol
 *
 *  Client → Server
 *    { type: "load_document",   documentId, userId, lastSeq? }
 *    { type: "insert",          node,       documentId }
 *    { type: "delete",          targetId,   documentId }
 *    { type: "cursor",          userId,     documentId, position }
 *    { type: "save_document",   documentId }
 *    { type: "create_document", documentId, documentName }
 *    { type: "get_documents" }
 *    { type: "delete_document", documentId }
 *
 *  Server → Client
 *    { type: "replay_start",    documentId, isFullLoad, count }
 *    { type: "op",              seq, op: { type:"insert"|"delete", ... } }
 *    { type: "replay_end",      documentId, latestSeq }
 *    { type: "op_ack",          seq }          ← confirms a sent op's seq
 *    { type: "cursor",          userId, position }
 *    { type: "cursor_remove",   userId }
 *    { type: "documents_list",  documents }
 *    { type: "document_created", documentId, documentName }
 *    { type: "document_saved",  documentId }
 *    { type: "document_deleted", documentId }
 */
export class EditorService {
    private crdt: CRDT;
    private ws: WebSocketService;
    private lastSyncedText: string = "";
    private _isApplyingRemote: boolean = false;
    private _isComposing: boolean = false;

    // Highest seq number we have received and applied from the server.
    // Sent as `lastSeq` on reconnect so the server can send only the diff.
    private lastSeq: number = -1;

    // Callbacks
    private onBeforeDocumentUpdate: (() => any) | null = null;
    private onDocumentUpdate: ((text: string, context?: any) => void) | null = null;
    private onCursorUpdate: ((cursors: Map<string, SharedCursorPosition>) => void) | null = null;
    private onDocumentsList: ((documents: any[]) => void) | null = null;
    private onDocumentCreated: ((documentId: string, documentName: string) => void) | null = null;
    private onDocumentDeleted: ((documentId: string) => void) | null = null;
    private onDocumentRenamed: ((documentId: string, documentName: string) => void) | null = null;

    private remoteCursors: Map<string, SharedCursorPosition> = new Map();
    private userId: string;
    private documentId: string;

    constructor(userId: string, documentId: string, wsUrl: string) {
        this.userId = userId;
        this.documentId = documentId;
        this.crdt = new CRDT(userId);
        this.ws = new WebSocketService(wsUrl);

        this.ws.onMessage((data: string) => this.handleServerMessage(data));

        // On reconnect:
        // - Do NOT reset the CRDT — it already has the user's offline edits.
        // - Send load_document with lastSeq so the server sends only missed ops.
        // - WebSocketService will flush the outgoing queue right after onopen,
        //   which happens before onReconnect fires, so our offline ops will
        //   already be in-flight by the time we ask for the catchup diff.
        this.ws.onReconnect(() => {
            console.log("[EditorService] Reconnected — catching up from seq", this.lastSeq);
            this.ws.send(JSON.stringify({
                type: "load_document",
                documentId: this.documentId,
                userId: this.userId,
                lastSeq: this.lastSeq,
            }));
        });

        // Initial load — no lastSeq, server sends full history
        this.loadDocument();
    }

    // ── Server message handler ────────────────────────────────────────────────

    private handleServerMessage(data: string) {
        let msg: any;
        try { msg = JSON.parse(data); }
        catch { console.error("[EditorService] Invalid JSON from server"); return; }

        switch (msg.type) {

            // replay_start: full load → reset CRDT so we start clean.
            //               catchup   → keep CRDT, just merge incoming ops.
            case "replay_start":
                if (msg.isFullLoad) {
                    this.crdt = new CRDT(this.userId);
                    this.lastSyncedText = "";
                    this.lastSeq = -1;
                    this.remoteCursors.clear();
                }
                break;

            // replay_end: update lastSeq to the server's current tip.
            case "replay_end":
                if (typeof msg.latestSeq === "number" && msg.latestSeq > this.lastSeq) {
                    this.lastSeq = msg.latestSeq;
                }
                break;

            // op: a single CRDT operation, either replayed or relayed from a peer.
            case "op": {
                const { seq, op } = msg;
                if (!op) return;

                const context = this.onBeforeDocumentUpdate?.();

                if (op.type === "insert") {
                    this.crdt.MergeRemoteNode(op.node);
                } else if (op.type === "delete") {
                    this.crdt.MergeRemoteDelete(op.targetId);
                }

                // Track the highest seq we've seen
                if (typeof seq === "number" && seq > this.lastSeq) {
                    this.lastSeq = seq;
                }

                this.reconcileToTextarea(context);
                break;
            }

            // op_ack: server confirmed receipt of one of our own ops and assigned
            // it a seq. Advance lastSeq so reconnect catchup starts after this.
            case "op_ack":
                if (typeof msg.seq === "number" && msg.seq > this.lastSeq) {
                    this.lastSeq = msg.seq;
                }
                break;

            case "cursor":
                if (msg.userId && msg.userId !== this.userId) {
                    this.remoteCursors.set(msg.userId, msg.position);
                    this.onCursorUpdate?.(this.remoteCursors);
                }
                break;

            case "cursor_remove":
                if (msg.userId) {
                    this.remoteCursors.delete(msg.userId);
                    this.onCursorUpdate?.(this.remoteCursors);
                }
                break;

            case "documents_list":
                this.onDocumentsList?.(msg.documents ?? []);
                break;

            case "document_created":
                this.onDocumentCreated?.(msg.documentId, msg.documentName ?? "Untitled");
                break;

            case "document_saved":
                console.log("[EditorService] Document saved:", msg.documentId);
                break;

            case "document_renamed":
                this.onDocumentRenamed?.(msg.documentId, msg.documentName);
                break;

            case "document_deleted":
                this.onDocumentDeleted?.(msg.documentId);
                break;

            default:
                break;
        }
    }

    // ── Document lifecycle ────────────────────────────────────────────────────

    /** Initial load — no lastSeq, server sends full history and resets CRDT. */
    loadDocument() {
        this.ws.send(JSON.stringify({
            type: "load_document",
            documentId: this.documentId,
            userId: this.userId,
            // No lastSeq → server will send isFullLoad: true
        }));
    }

    saveDocument() {
        this.ws.send(JSON.stringify({ type: "save_document", documentId: this.documentId }));
    }

    createDocument(documentId: string, documentName: string) {
        this.ws.send(JSON.stringify({ type: "create_document", documentId, documentName }));
    }

    getDocuments() {
        this.ws.send(JSON.stringify({ type: "get_documents" }));
    }

    renameDocument(documentId: string, newName: string) {
        this.ws.send(JSON.stringify({ type: "rename_document", documentId, newName }));
    }

    deleteDocument(documentId: string) {
        this.ws.send(JSON.stringify({ type: "delete_document", documentId }));
    }

    sendCursorPosition(position: SharedCursorPosition) {
        this.ws.send(JSON.stringify({
            type: "cursor",
            userId: this.userId,
            documentId: this.documentId,
            position,
        }));
    }

    // ── Getters ───────────────────────────────────────────────────────────────

    get isApplyingRemote(): boolean { return this._isApplyingRemote; }
    get isWsConnected(): boolean { return this.ws.isConnected; }

    getText(): string {
        return this.crdt.DocumentReconciliation();
    }

    getAnchorAtVisibleIndex(index: number): any {
        return this.crdt.getAnchorAtVisibleIndex(index);
    }

    getVisibleIndexFromAnchor(anchorId: any): number {
        return this.crdt.getVisibleIndexFromAnchor(anchorId);
    }

    // ── IME / composition ─────────────────────────────────────────────────────

    compositionStart() { this._isComposing = true; }
    compositionEnd() { this._isComposing = false; }
    get isComposing(): boolean { return this._isComposing; }

    // ── Local input ───────────────────────────────────────────────────────────

    handleTextChange(newText: string): void {
        if (this._isComposing) return;
        const oldText = this.lastSyncedText;
        if (oldText === newText) return;
        this.applyDiff(oldText, newText);
    }

    private applyDiff(oldText: string, newText: string): void {
        let prefixLen = 0;
        const minLen = Math.min(oldText.length, newText.length);
        while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) prefixLen++;

        let suffixLen = 0;
        while (
            suffixLen < minLen - prefixLen &&
            oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
        ) suffixLen++;

        const deleteCount = oldText.length - prefixLen - suffixLen;
        const insertStr = newText.slice(prefixLen, newText.length - suffixLen);

        for (let i = 0; i < deleteCount; i++) {
            const deletedId = this.crdt.DeleteAtIndex(prefixLen);
            if (deletedId) {
                // Applied locally already; queue/send to server.
                // If offline, WebSocketService queues this automatically.
                this.ws.send(JSON.stringify({
                    type: "delete",
                    targetId: { id: deletedId.id, seq: deletedId.seq },
                    documentId: this.documentId,
                }));
            }
        }

        for (let i = 0; i < insertStr.length; i++) {
            const insertAfterIdx = prefixLen - 1 + i;
            const node = this.crdt.InsertAfterIndex(insertAfterIdx, insertStr[i]);
            if (node) {
                this.ws.send(JSON.stringify({
                    type: "insert",
                    node: {
                        id: { id: node.id.id, seq: node.id.seq },
                        value: node.value,
                        parent: node.parent ? { id: node.parent.id, seq: node.parent.seq } : null,
                        is_deleted: node.is_deleted,
                    },
                    documentId: this.documentId,
                }));
            }
        }

        this.lastSyncedText = this.crdt.DocumentReconciliation();
    }

    // ── Reconcile textarea to CRDT state ─────────────────────────────────────

    private reconcileToTextarea(context?: any): void {
        this._isApplyingRemote = true;
        this.lastSyncedText = this.crdt.DocumentReconciliation();
        this.onDocumentUpdate?.(this.lastSyncedText, context);
        this._isApplyingRemote = false;
    }

    forceReconcile(): void { this.reconcileToTextarea(); }

    // ── Callback setters ─────────────────────────────────────────────────────

    setOnBeforeDocumentUpdate(cb: () => any) {
        this.onBeforeDocumentUpdate = cb;
    }

    setOnDocumentUpdate(cb: (text: string, context?: any) => void) {
        this.onDocumentUpdate = cb;
    }

    setOnCursorUpdate(cb: (cursors: Map<string, SharedCursorPosition>) => void) {
        this.onCursorUpdate = cb;
    }

    setOnDocumentsList(cb: (documents: any[]) => void) {
        this.onDocumentsList = cb;
    }

    setOnDocumentCreated(cb: (documentId: string, documentName: string) => void) {
        this.onDocumentCreated = cb;
    }

    setOnDocumentRenamed(cb: (documentId: string, documentName: string) => void) {
        this.onDocumentRenamed = cb;
    }

    setOnDocumentDeleted(cb: (documentId: string) => void) {
        this.onDocumentDeleted = cb;
    }

    destroy() { this.ws.close(); }
}