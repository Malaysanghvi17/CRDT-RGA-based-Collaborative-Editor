export class CRDTID {
    readonly id: string;
    readonly seq: number;

    constructor(id: string, seq: number) {
        this.id = id;
        this.seq = seq;
    }

    compareTo(other: CRDTID): number {
        if (this.seq !== other.seq) {
            return this.seq - other.seq;
        }
        return this.id < other.id ? -1 : (this.id > other.id ? 1 : 0);
    }

    equals(other: CRDTID): boolean {
        return this.id === other.id && this.seq === other.seq;
    }

    toString(): string {
        return `${this.id}:${this.seq}`;
    }
}

export class CRDTNode {
    id: CRDTID;
    value: string;
    next: CRDTID | null;
    parent: CRDTID | null;
    is_deleted: boolean;

    constructor(
        id: CRDTID,
        value: string,
        next: CRDTID | null,
        parent: CRDTID | null,
        is_deleted: boolean = false
    ) {
        this.id = id;
        this.value = value;
        this.next = next;
        this.parent = parent;
        this.is_deleted = is_deleted;
    }

    toString(): string {
        return `[${this.id.toString()} val='${this.value}' del=${this.is_deleted} next=${this.next?.toString()}]`;
    }
}