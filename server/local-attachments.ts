import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function localAttachments(directory = resolve(".local/attachments")) {
	return async (key: string): Promise<Uint8Array | null> => {
		if (!/^[a-f0-9-]{36}$/.test(key)) return null;
		try {
			return new Uint8Array(await readFile(resolve(directory, key)));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return null;
			throw error;
		}
	};
}
