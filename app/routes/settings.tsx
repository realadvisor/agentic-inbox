import ClassifierRuns from "~/components/ClassifierRuns";
// Modified for the RealAdvisor local Postgres prototype.
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Classifiers } from "~/components/Classifiers";
import { useMailMode } from "~/components/MailMode";
import { useSearchParams } from "react-router";
import { TagSettings } from "~/components/TagSettings";
import { Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const mode = useMailMode();
	const hasClassifiers =
		mode.data?.classifierPreview || mode.data?.classifiersEnabled;
	const [params, setParams] = useSearchParams();
	const tab = params.get("tab") ?? "classifiers";
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
		}
	}, [mailbox]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSaving(true);
		const settings = {
			...mailbox.settings,
			fromName: displayName,
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved!" });
		} catch {
			toastManager.add({
				title: "Failed to save settings",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	return (
		<div
			className={`${tab === "runs" ? "" : "max-w-2xl"} px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto`}
		>
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			{hasClassifiers && (
				<div
					className="flex flex-wrap gap-2 mb-6"
					aria-label="Settings sections"
				>
					{[
						"account",
						"tags",
						"classifiers",
						...(mode.data?.canManageClassifiers ? ["runs"] : []),
					].map((t) => (
						<Button
							key={t}
							variant={tab === t ? "primary" : "ghost"}
							onClick={() => setParams({ tab: t })}
						>
							{t[0].toUpperCase() + t.slice(1)}
						</Button>
					))}
				</div>
			)}
			{hasClassifiers && tab === "runs" ? (
				<ClassifierRuns />
			) : hasClassifiers && tab === "classifiers" ? (
				<Classifiers />
			) : hasClassifiers && tab === "tags" ? (
				<TagSettings />
			) : (
				<div className="space-y-6">
					<TagSettings />
					{/* Account */}
					<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
						<div className="text-sm font-medium text-kumo-default mb-4">
							Account
						</div>
						<div className="space-y-3">
							<Input
								label="Display Name"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
							/>
							<Input
								label="Email"
								type="email"
								value={mailbox.email}
								disabled
							/>
						</div>
					</div>

					{/* Save */}
					<div className="flex justify-end">
						<Button variant="primary" onClick={handleSave} loading={isSaving}>
							Save Changes
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
