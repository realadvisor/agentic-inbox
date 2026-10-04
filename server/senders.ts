import { HTTPException } from "hono/http-exception";
import type { Database } from "./db";
import { mailboxConfig } from "./mailboxes";
import {
	resolveSenderId,
	type SenderConfiguration,
	type SenderContext,
	type SenderIdentity,
} from "../shared/senders";

export class SenderStore {
	constructor(readonly db: Database) {}
	async configuration(): Promise<SenderConfiguration> {
		const senders = await this.db<
			SenderIdentity[]
		>`SELECT s.*,COALESCE(m.settings->>'fromName',m.name,s.email) AS name,m.settings
   FROM sender_identities s LEFT JOIN mailboxes m ON m.id=s.mailbox_id ORDER BY s.email`;
		const [settings] = await this.db<
			{ default_sender_identity_id: string | null }[]
		>`SELECT default_sender_identity_id FROM inbox_settings WHERE id`;
		return {
			senders,
			default_sender_identity_id: settings?.default_sender_identity_id ?? null,
		};
	}
	async resolve(
		context: SenderContext,
		options: { live?: boolean; mailboxIds?: string[] } = {},
	) {
		const config = await this.configuration();
		const id = resolveSenderId(config, context);
		const sender = config.senders.find((s) => s.id === id);
		if (!sender || !sender.active || !sender.mailbox_id)
			throw new HTTPException(409, {
				message:
					"Choose an available sender; the default or matching sender is missing, unavailable, or ambiguous.",
			});
		if (options.mailboxIds && !options.mailboxIds.includes(sender.mailbox_id))
			throw new HTTPException(403, {
				message: "API key does not permit this sender's mailbox",
			});
		if (
			options.live &&
			(await mailboxConfig(this.db, sender.mailbox_id))?.from !== sender.email
		)
			throw new HTTPException(403, {
				message: "Sender is not enabled for live sending",
			});
		return sender;
	}
	async setDefault(
		id: string,
		options: { live?: boolean; mailboxIds?: string[] } = {},
	) {
		await this.resolve({ explicit: id, mailboxId: "" }, options);
		await this
			.db`UPDATE inbox_settings SET default_sender_identity_id=${id} WHERE id`;
		return this.configuration();
	}
}
