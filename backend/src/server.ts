import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: "../.env" });

// ── Mongoose setup ────────────────────────────────────────────────────────────

const MONGO_URI = process.env.MONGODB_URI || "";
const SAVE_INTERVAL = 1000;

const documentSchema = new mongoose.Schema({
    documentId: { type: String, required: true, unique: true },
    documentName: { type: String, default: "Untitled" },
    // Each entry: { seq: number, raw: string }
    crdtNodes: { type: Array, default: [] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

const DocumentModel = mongoose.model("Document", documentSchema);

const pageSchema = new mongoose.Schema({
    route: { type: String, required: true, unique: true },
    htmlContent: { type: String, default: "" },
    isDefault: { type: Boolean, default: false }
});
const PageModel = mongoose.model("Page", pageSchema);

async function seedPages() {
    const defaultPage = await PageModel.findOne({ route: "/editor" });
    if (!defaultPage) {
        await PageModel.create({
            route: "/editor",
            htmlContent: "",
            isDefault: true
        });
    }
    const aboutPage = await PageModel.findOne({ route: "/about" });
    if (!aboutPage) {
        await PageModel.create({
            route: "/about",
            htmlContent: `
    <div class="about-content">
      <h1>About Collab Editor</h1>
      <p>A real-time collaborative text editor powered by CRDTs.</p>
      
      <div class="about-card" style="margin-top: 20px;">
        <h3>How It Works</h3>
        <p style="font-size: 13.5px; margin-bottom: 12px;">This editor ensures conflict-free concurrent editing using a <strong>Conflict-Free Replicated Data Type (CRDT)</strong>. Instead of locking the document or relying on operational transformation (OT) via a central server, every character typed is assigned a unique, immutable identifier based on a Lamport timestamp and a client ID.</p>
        <p style="font-size: 13.5px; margin-bottom: 12px;">Specifically, the system uses an <strong>RGA (Replicated Growable Array)</strong>. When someone types or deletes characters, those specific operations are broadcasted via WebSockets to all connected peers. Because the operations are commutative and tied to unique IDs, they can arrive in any order and the document state will mathematically converge to the precise same text for everyone.</p>
        <p style="font-size: 13.5px; margin-bottom: 0;">The entire backend routing runs on an Express server managing WebSockets, backed by MongoDB to persist the operational logs.</p>
      </div>

      <div class="about-card">
        <h3>Features</h3>
        <ul>
          <li>Real-time collaborative editing</li>
          <li>CRDT-based conflict resolution (RGA)</li>
          <li>Live cursor sharing</li>
          <li>IME / composition input support</li>
          <li>Offline editing with automatic sync on reconnect</li>
          <li>Multiple document support</li>
        </ul>
      </div>
    </div>
            `,
            isDefault: false
        });
    }
}

mongoose
    .connect(MONGO_URI)
    .then(() => console.log("[DB] MongoDB connected"))
    .catch((err) => console.error("[DB] Connection error:", err));

// ── Types ─────────────────────────────────────────────────────────────────────

interface OpEntry {
    seq: number;  // 1-based, monotonically increasing per document
    raw: string;  // original JSON string from the client
}

// ── In-memory state ───────────────────────────────────────────────────────────

const clients = new Map<WebSocket, string>();
const websockets = new Map<string, WebSocket>();
const docClients = new Map<string, Set<string>>();
const docOplogs = new Map<string, OpEntry[]>();
const docNames = new Map<string, string>();
const clientMeta = new Map<string, { userId: string | null; documentId: string | null }>();

// ── DB helpers ────────────────────────────────────────────────────────────────

async function loadDocumentsFromDB() {
    const docs = await DocumentModel.find();
    for (const doc of docs) {
        // Migrate old plain-string format if needed
        const entries: OpEntry[] = (doc.crdtNodes ?? []).map((e: any, i: number) =>
            typeof e === "string" ? { seq: i + 1, raw: e } : (e as OpEntry)
        );
        docOplogs.set(doc.documentId, entries);
        docNames.set(doc.documentId, doc.documentName ?? "Untitled");
        docClients.set(doc.documentId, new Set());
    }
    console.log(`[DB] Loaded ${docs.length} documents`);
}

async function saveAllDocuments() {
    let saved = 0;
    for (const [docId, opLog] of docOplogs) {
        await DocumentModel.findOneAndUpdate(
            { documentId: docId },
            { documentName: docNames.get(docId) ?? "Untitled", crdtNodes: opLog, updatedAt: new Date() },
            { upsert: true }
        );
        saved++;
    }
    if (saved > 0) console.log(`[DB] Periodic save — ${saved} documents`);
}

setInterval(saveAllDocuments, SAVE_INTERVAL);

// ── Utilities ─────────────────────────────────────────────────────────────────

function safeSend(ws: WebSocket, data: object | string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) {
        console.warn("[WS] Dropping client — excessive backpressure");
        ws.terminate();
        cleanupClient(ws);
        return;
    }
    ws.send(typeof data === "string" ? data : JSON.stringify(data));
}

function broadcastToDoc(docId: string, senderWs: WebSocket, payload: string) {
    const senderId = clients.get(senderWs);
    const members = docClients.get(docId);
    if (!members) return;
    for (const cid of members) {
        if (cid === senderId) continue;
        const ws = websockets.get(cid);
        if (ws) safeSend(ws, payload);
    }
}

function cleanupClient(ws: WebSocket) {
    const clientId = clients.get(ws);
    if (!clientId) return;

    const meta = clientMeta.get(clientId);

    for (const members of docClients.values()) members.delete(clientId);

    if (meta?.userId && meta?.documentId) {
        const removeMsg = JSON.stringify({ type: "cursor_remove", userId: meta.userId });
        const members = docClients.get(meta.documentId);
        if (members) {
            for (const cid of members) {
                const targetWs = websockets.get(cid);
                if (targetWs) safeSend(targetWs, removeMsg);
            }
        }
    }

    clients.delete(ws);
    websockets.delete(clientId);
    clientMeta.delete(clientId);
    console.log(`[WS] Cleaned up client: ${clientId}`);
}

// ── Express + WebSocket server ────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── Pages API ─────────────────────────────────────────────────────────────────

app.get("/api/pages/default", async (req, res) => {
    try {
        const defaultPage = await PageModel.findOne({ isDefault: true });
        if (defaultPage) {
            res.json({ route: defaultPage.route });
        } else {
            res.json({ route: "/editor" });
        }
    } catch (err) {
        console.error("[API] Error fetching default page:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get("/api/pages/:page", async (req, res) => {
    try {
        const route = "/" + req.params.page;
        const page = await PageModel.findOne({ route });
        if (page) {
            res.json({ htmlContent: page.htmlContent });
        } else {
            res.status(404).json({ error: "Page not found" });
        }
    } catch (err) {
        console.error("[API] Error fetching page:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.use(express.static(path.join(__dirname, "../public")));
app.use((req, res, next) => {
    if (path.extname(req.path)) return next();
    res.sendFile(path.join(__dirname, "../public/index.html"));
});

wss.on("connection", (ws) => {
    const clientId = uuidv4();
    clients.set(ws, clientId);
    websockets.set(clientId, ws);
    clientMeta.set(clientId, { userId: null, documentId: null });
    console.log(`[WS] Connected: ${clientId} (total: ${clients.size})`);

    ws.on("message", async (data) => {
        const raw = data.toString();
        let parsed: any;
        try { parsed = JSON.parse(raw); }
        catch { console.error("[WS] Invalid JSON"); return; }

        const cid = clients.get(ws);
        if (!cid) return;

        switch (parsed.type) {

            // ── Document CRUD ──────────────────────────────────────────────
            case "create_document": {
                const { documentId, documentName } = parsed;
                if (!documentId) return;
                if (!docOplogs.has(documentId)) {
                    docOplogs.set(documentId, []);
                    docNames.set(documentId, documentName ?? "Untitled");
                    docClients.set(documentId, new Set());
                    await DocumentModel.create({
                        documentId,
                        documentName: documentName ?? "Untitled",
                        crdtNodes: [],
                    });
                }
                safeSend(ws, { type: "document_created", documentId, documentName: docNames.get(documentId) });
                break;
            }

            case "rename_document": {
                const { documentId, newName } = parsed;
                if (!documentId || !newName) return;
                docNames.set(documentId, newName);
                await DocumentModel.findOneAndUpdate(
                    { documentId },
                    { documentName: newName }
                );
                const msg = JSON.stringify({ type: "document_renamed", documentId, documentName: newName });
                for (const [clientWs] of clients) safeSend(clientWs, msg);
                break;
            }

            case "get_documents": {
                const docs = Array.from(docOplogs.keys()).map(id => ({
                    documentId: id,
                    documentName: docNames.get(id) ?? "Untitled",
                }));
                safeSend(ws, { type: "documents_list", documents: docs });
                break;
            }

            case "delete_document": {
                const { documentId } = parsed;
                if (!documentId) return;
                docOplogs.delete(documentId);
                docNames.delete(documentId);
                docClients.delete(documentId);
                await DocumentModel.deleteOne({ documentId });
                const msg = JSON.stringify({ type: "document_deleted", documentId });
                for (const [clientWs] of clients) safeSend(clientWs, msg);
                break;
            }

            // ── Load / reconnect-catchup ───────────────────────────────────
            //
            // First load:   { type: "load_document", documentId, userId }
            //               lastSeq is absent → server sends ALL ops
            //
            // Reconnect:    { type: "load_document", documentId, userId, lastSeq: N }
            //               server sends only ops with seq > N
            //               client keeps its CRDT intact and merges only the diff
            //
            case "load_document": {
                const { documentId, userId } = parsed;
                const lastSeq: number = typeof parsed.lastSeq === "number" ? parsed.lastSeq : -1;
                if (!documentId) return;

                clientMeta.set(cid, { userId: userId ?? null, documentId });

                if (!docOplogs.has(documentId)) {
                    const dbDoc = await DocumentModel.findOne({ documentId });
                    if (dbDoc) {
                        const entries: OpEntry[] = (dbDoc.crdtNodes ?? []).map((e: any, i: number) =>
                            typeof e === "string" ? { seq: i + 1, raw: e } : e
                        );
                        docOplogs.set(documentId, entries);
                        docNames.set(documentId, dbDoc.documentName ?? "Untitled");
                    } else {
                        docOplogs.set(documentId, []);
                        docNames.set(documentId, "Untitled");
                    }
                    docClients.set(documentId, new Set());
                }

                docClients.get(documentId)!.add(cid);

                const opLog = docOplogs.get(documentId)!;
                const toSend = lastSeq === -1 ? opLog : opLog.filter(e => e.seq > lastSeq);
                const latestSeq = opLog.length > 0 ? opLog[opLog.length - 1].seq : 0;

                // Tells client how many ops are coming and whether this is a full
                // load or a partial catchup, so it can decide whether to reset CRDT.
                safeSend(ws, {
                    type: "replay_start",
                    documentId,
                    isFullLoad: lastSeq === -1,
                    count: toSend.length,
                });

                for (const entry of toSend) {
                    // Each op is wrapped with its sequence number.
                    // The client unwraps and feeds the inner op to the CRDT.
                    const envelope = JSON.stringify({
                        type: "op",
                        seq: entry.seq,
                        op: JSON.parse(entry.raw),
                    });
                    safeSend(ws, envelope);
                }

                safeSend(ws, { type: "replay_end", documentId, latestSeq });

                console.log(
                    `[WS] ${cid} joined doc ${documentId} — ` +
                    `replayed ${toSend.length} ops (lastSeq=${lastSeq}, latestSeq=${latestSeq})`
                );
                break;
            }

            // ── Manual save ────────────────────────────────────────────────
            case "save_document": {
                const { documentId } = parsed;
                if (!documentId) return;
                const opLog = docOplogs.get(documentId);
                if (opLog) {
                    await DocumentModel.findOneAndUpdate(
                        { documentId },
                        { documentName: docNames.get(documentId) ?? "Untitled", crdtNodes: opLog, updatedAt: new Date() },
                        { upsert: true }
                    );
                    safeSend(ws, { type: "document_saved", documentId });
                }
                break;
            }

            // ── Cursor ─────────────────────────────────────────────────────
            case "cursor": {
                const meta = clientMeta.get(cid)!;
                const docId = parsed.documentId ?? meta.documentId;
                if (parsed.userId) meta.userId = parsed.userId;
                if (parsed.documentId) meta.documentId = parsed.documentId;
                if (!docId) return;
                broadcastToDoc(docId, ws, raw);
                break;
            }

            // ── CRDT ops: insert / delete ──────────────────────────────────
            //
            // Client sends: { type: "insert"|"delete", documentId?, ...payload }
            // Server assigns a seq, stores it, ACKs the sender, and relays
            // { type: "op", seq, op: <original parsed message> } to peers.
            //
            case "insert":
            case "delete": {
                const meta = clientMeta.get(cid);
                const docId = parsed.documentId ?? meta?.documentId;
                if (!docId) return;

                const opLog = docOplogs.get(docId) ?? [];
                const nextSeq = opLog.length > 0 ? opLog[opLog.length - 1].seq + 1 : 1;
                opLog.push({ seq: nextSeq, raw });
                docOplogs.set(docId, opLog);

                const envelope = JSON.stringify({ type: "op", seq: nextSeq, op: parsed });

                // Relay to peers
                broadcastToDoc(docId, ws, envelope);

                // ACK sender so it advances its lastSeq
                safeSend(ws, JSON.stringify({ type: "op_ack", seq: nextSeq }));
                break;
            }

            default:
                console.log("[WS] Unknown message type:", parsed.type);
        }
    });

    ws.on("close", () => {
        cleanupClient(ws);
        console.log(`[WS] Disconnected (total: ${clients.size})`);
    });

    ws.on("error", (err) => {
        console.error("[WS] Error:", err.message);
        ws.terminate();
        cleanupClient(ws);
    });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 8080;

loadDocumentsFromDB().then(async () => {
    await seedPages();
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`[HTTP] Listening on http://0.0.0.0:${PORT}`);
        console.log(`[WS]   WebSocket on ws://0.0.0.0:${PORT}`);
    });
});