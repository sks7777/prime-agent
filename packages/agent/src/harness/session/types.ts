// Minimal session types for search module compatibility
export interface SessionMetadata {
	id: string;
	createdAt: number;
	parentSessionId?: string;
}

export interface Entry {
	type: string;
	id: string;
	seq: number;
	parentId: string | null;
	timestamp: number;
}

export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
	getMetadata(): Promise<TMetadata>;
	getEntries(): Promise<Entry[]>;
	findEntries(query?: unknown): Promise<Entry[]>;
	getLabel(lane?: string): Promise<string | undefined>;
}
