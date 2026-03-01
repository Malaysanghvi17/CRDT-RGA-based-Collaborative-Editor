import { WebSocketService } from "./websocket.service";

export class DocumentService {
    private ws: WebSocketService;
    private onDocumentsList: ((documents: any[]) => void) | null = null;
    private onDocumentCreated: ((documentId: string) => void) | null = null;
    private onDocumentDeleted: ((documentId: string) => void) | null = null;

    constructor(wsUrl: string) {
        this.ws = new WebSocketService(wsUrl);

        this.ws.onMessage((data: string) => {
            const msg = JSON.parse(data);
            if (msg.type === "documents_list" && this.onDocumentsList) {
                this.onDocumentsList(msg.documents);
            } else if (msg.type === "document_created" && this.onDocumentCreated) {
                this.onDocumentCreated(msg.documentId);
            } else if (msg.type === "document_deleted" && this.onDocumentDeleted) {
                this.onDocumentDeleted(msg.documentId);
            }
        });
    }

    setOnDocumentsList(cb: (documents: any[]) => void) {
        this.onDocumentsList = cb;
    }

    setOnDocumentCreated(cb: (documentId: string) => void) {
        this.onDocumentCreated = cb;
    }

    setOnDocumentDeleted(cb: (documentId: string) => void) {
        this.onDocumentDeleted = cb;
    }

    createDocument(documentId: string) {
        this.ws.send(JSON.stringify({ type: "create_document", documentId }));
    }

    getDocuments() {
        this.ws.send(JSON.stringify({ type: "get_documents" }));
    }

    deleteDocument(documentId: string) {
        this.ws.send(JSON.stringify({ type: "delete_document", documentId }));
    }

    destroy() {
        this.ws.close();
    }
}
