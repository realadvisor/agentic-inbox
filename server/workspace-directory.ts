import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import type { RecipientSuggestion } from "../shared/contacts";

export interface WorkspaceDirectoryEnv {
	GOOGLE_DIRECTORY_SERVICE_ACCOUNT?: string;
	GOOGLE_DIRECTORY_PRIVATE_KEY?: string;
	GOOGLE_DIRECTORY_USER?: string;
}
export type DirectorySearch = (query: string) => Promise<RecipientSuggestion[]>;
const scope = "https://www.googleapis.com/auth/directory.readonly";
const peopleSchema = z.object({
	people: z
		.array(
			z.object({
				names: z
					.array(
						z.object({
							displayName: z.string().optional(),
							metadata: z
								.object({ primary: z.boolean().optional() })
								.optional(),
						}),
					)
					.optional(),
				emailAddresses: z
					.array(
						z.object({
							value: z.string(),
							metadata: z
								.object({ primary: z.boolean().optional() })
								.optional(),
						}),
					)
					.optional(),
			}),
		)
		.default([]),
});

// One instance per configured identity; no query, token or private key is logged.
export function createDirectorySearch(
	env: Required<WorkspaceDirectoryEnv>,
	transport: typeof fetch = fetch,
): DirectorySearch {
	let token: { value: string; expires: number } | undefined;
	let tokenRequest: Promise<string> | undefined;
	let retryAfter = 0;
	const cache = new Map<
		string,
		{ expires: number; results: RecipientSuggestion[] }
	>();
	const pending = new Map<string, Promise<RecipientSuggestion[]>>();
	async function accessToken(signal: AbortSignal) {
		if (token && token.expires > Date.now() + 60_000) return token.value;
		if (tokenRequest) return tokenRequest;
		tokenRequest = (async () => {
			const key = await importPKCS8(
				env.GOOGLE_DIRECTORY_PRIVATE_KEY.replaceAll("\\n", "\n"),
				"RS256",
			);
			const assertion = await new SignJWT({ scope })
				.setProtectedHeader({ alg: "RS256" })
				.setIssuer(env.GOOGLE_DIRECTORY_SERVICE_ACCOUNT)
				.setSubject(env.GOOGLE_DIRECTORY_USER)
				.setAudience("https://oauth2.googleapis.com/token")
				.setIssuedAt()
				.setExpirationTime("5m")
				.sign(key);
			const response = await transport("https://oauth2.googleapis.com/token", {
				method: "POST",
				signal,
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
					assertion,
				}),
			});
			if (!response.ok) throw new Error("Directory authentication failed");
			const data = z
				.object({
					access_token: z.string().min(1),
					expires_in: z.number().positive(),
				})
				.parse(await response.json());
			token = {
				value: data.access_token,
				expires: Date.now() + Math.min(data.expires_in, 3600) * 1000,
			};
			return token.value;
		})();
		try {
			return await tokenRequest;
		} finally {
			tokenRequest = undefined;
		}
	}
	return async (rawQuery) => {
		const query = rawQuery.trim().toLowerCase();
		if (query.length < 2 || query.length > 100) return [];
		const cached = cache.get(query);
		if (cached && cached.expires > Date.now()) return cached.results;
		if (Date.now() < retryAfter) return [];
		const existing = pending.get(query);
		if (existing) return existing;
		// Bound concurrent lookups as well as cached prefixes.
		if (pending.size >= 20) return [];
		const task = (async () => {
			try {
				const signal = AbortSignal.timeout(1500);
				const bearer = await accessToken(signal);
				const url = new URL(
					"https://people.googleapis.com/v1/people:searchDirectoryPeople",
				);
				url.search = new URLSearchParams({
					query,
					readMask: "names,emailAddresses",
					sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
					pageSize: "20",
				}).toString();
				const response = await transport(url, {
					signal,
					headers: { Authorization: `Bearer ${bearer}` },
				});
				if (!response.ok) {
					if (response.status === 401) token = undefined;
					throw new Error("Directory lookup failed");
				}
				const data = peopleSchema.parse(await response.json());
				const results: RecipientSuggestion[] = [];
				const seen = new Set<string>();
				for (const person of data.people) {
					const address =
						person.emailAddresses?.find((email) => email.metadata?.primary) ??
						person.emailAddresses?.[0];
					const email = address?.value.trim().toLowerCase();
					if (
						!email ||
						!z.string().email().safeParse(email).success ||
						seen.has(email)
					)
						continue;
					seen.add(email);
					results.push({
						email,
						name:
							(
								person.names?.find((name) => name.metadata?.primary) ??
								person.names?.[0]
							)?.displayName ?? null,
					});
				}
				if (cache.size >= 128) cache.delete(cache.keys().next().value!);
				cache.set(query, { results, expires: Date.now() + 60_000 });
				return results;
			} catch {
				retryAfter = Date.now() + 30_000;
				console.warn(
					"Workspace directory lookup unavailable; using mailbox contacts",
				);
				return [];
			}
		})();
		pending.set(query, task);
		try {
			return await task;
		} finally {
			pending.delete(query);
		}
	};
}
let configured:
	{ env: Required<WorkspaceDirectoryEnv>; search: DirectorySearch } | undefined;
export function workspaceDirectory(
	env: WorkspaceDirectoryEnv,
): DirectorySearch | undefined {
	const {
		GOOGLE_DIRECTORY_SERVICE_ACCOUNT,
		GOOGLE_DIRECTORY_PRIVATE_KEY,
		GOOGLE_DIRECTORY_USER,
	} = env;
	if (
		!GOOGLE_DIRECTORY_SERVICE_ACCOUNT ||
		!GOOGLE_DIRECTORY_PRIVATE_KEY ||
		!GOOGLE_DIRECTORY_USER
	)
		return undefined;
	if (
		configured &&
		Object.entries(configured.env).every(
			([key, value]) => env[key as keyof WorkspaceDirectoryEnv] === value,
		)
	)
		return configured.search;
	const settings = {
		GOOGLE_DIRECTORY_SERVICE_ACCOUNT,
		GOOGLE_DIRECTORY_PRIVATE_KEY,
		GOOGLE_DIRECTORY_USER,
	};
	configured = { env: settings, search: createDirectorySearch(settings) };
	return configured.search;
}
