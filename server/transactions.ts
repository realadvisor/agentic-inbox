import type { Database } from "./db";

/** Reuse domain services inside the agent's lease-fenced transaction. */
export function transaction<T>(
	db: Database,
	callback: (tx: Database) => Promise<T>,
): Promise<T> {
	const scoped = db as unknown as {
		savepoint?: (fn: (tx: Database) => Promise<T>) => Promise<T>;
	};
	if (scoped.savepoint) return scoped.savepoint(callback);
	return db.begin((tx) => callback(tx as unknown as Database)) as Promise<T>;
}
