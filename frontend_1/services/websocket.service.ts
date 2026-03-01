export class WebSocketService {
    private ws: WebSocket | null = null;
    private url: string;
    private messageHandler: ((data: string) => void) | null = null;
    private statusHandler: ((connected: boolean) => void) | null = null;
    private reconnectHandler: (() => void) | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelay: number = 500;
    private maxReconnectDelay: number = 10000;
    private _isConnected: boolean = false;
    private outgoingQueue: string[] = [];

    constructor(url: string) {
        this.url = url;
        this.connect();
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    onMessage(handler: (data: string) => void) {
        this.messageHandler = handler;
    }

    onReconnect(handler: () => void) {
        this.reconnectHandler = handler;
    }

    /** Send message. If disconnected, queues for later delivery. */
    send(msg: string) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(msg);
        } else {
            console.log("offline: " , this.outgoingQueue);
            
            this.outgoingQueue.push(msg);
        }
    }

    close() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
        }
    }

    private connect() {
        try {
            this.ws = new WebSocket(this.url);
        } catch {
            this.scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            this._isConnected = true;
            this.reconnectDelay = 500;
            this.statusHandler?.(true);
            console.log("[WS] Connected");
            this.reconnectHandler?.();
            this.flushQueue();
        };

        this.ws.onmessage = (event) => {
            if (this.messageHandler && typeof event.data === "string") {
                this.messageHandler(event.data);
            }
        };

        this.ws.onclose = () => {
            this._isConnected = false;
            this.statusHandler?.(false);
            console.log("[WS] Disconnected — reconnecting...");
            this.scheduleReconnect();
        };

        this.ws.onerror = () => {
            this.ws?.close();
        };
    }

    private flushQueue() {
        while (this.outgoingQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(this.outgoingQueue.shift()!);
        }
    }

    private scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
            this.connect();
        }, this.reconnectDelay);
    }
}
