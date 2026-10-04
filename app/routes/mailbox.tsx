// Modified for the RealAdvisor local Postgres prototype.
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useLayoutEffect, useRef } from "react";
import { Outlet, useParams, useLocation, useNavigate } from "react-router";
import AgentPanel from "~/components/AgentPanel";
import ComposeEmail from "~/components/ComposeEmail";
import Header from "~/components/Header";
import Sidebar from "~/components/Sidebar";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";

export default function MailboxRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const location = useLocation();
	const navigate = useNavigate();
	const locationRef = useRef(location);
	const syncingUrl = useRef(false);
	// Prefetch mailbox data for child components
	useMailbox(mailboxId);
	const prevMailboxIdRef = useRef<string | undefined>(undefined);
	const {
		isSidebarOpen,
		closeSidebar,
		closePanel,
		closeComposeModal,
		isAgentOpen,
		closeAgent,
	} = useUIStore();

	useLayoutEffect(() => {
		locationRef.current = location;
		syncingUrl.current = true;
		try {
			if (prevMailboxIdRef.current && prevMailboxIdRef.current !== mailboxId) {
				closePanel();
				closeComposeModal();
				closeSidebar();
			}
			const candidate = new URLSearchParams(location.search).get("email");
			const detailRoute = /\/(?:emails\/[^/]+|search)\/?$/.test(
				location.pathname,
			);
			const email =
				detailRoute &&
				candidate &&
				/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(candidate)
					? candidate
					: null;
			if (useUIStore.getState().selectedEmailId !== email)
				useUIStore.getState().selectEmail(email);
			prevMailboxIdRef.current = mailboxId;
		} finally {
			syncingUrl.current = false;
		}
	}, [location, mailboxId, closePanel, closeComposeModal, closeSidebar]);

	useEffect(
		() =>
			useUIStore.subscribe((state, previous) => {
				if (
					syncingUrl.current ||
					state.selectedEmailId === previous.selectedEmailId
				)
					return;
				const current = locationRef.current;
				if (!/\/(?:emails\/[^/]+|search)\/?$/.test(current.pathname)) return;
				const params = new URLSearchParams(current.search);
				if (state.selectedEmailId) params.set("email", state.selectedEmailId);
				else params.delete("email");
				const search = params.toString();
				if (search === current.search.replace(/^\?/, "")) return;
				void navigate(
					{
						pathname: current.pathname,
						search: search ? `?${search}` : "",
						hash: current.hash,
					},
					{ preventScrollReset: true },
				);
			}),
		[navigate],
	);

	return (
		<div className="flex h-[calc(100dvh-36px)] overflow-hidden">
			{/* Mobile sidebar overlay backdrop */}
			{isSidebarOpen && (
				<div
					className="fixed inset-0 z-30 bg-black/30 md:hidden"
					onClick={closeSidebar}
					onKeyDown={(e) => e.key === "Escape" && closeSidebar()}
					role="button"
					tabIndex={-1}
					aria-label="Close sidebar"
				/>
			)}

			{/* Sidebar: hidden on mobile by default, shown as overlay when open */}
			<div
				className={`fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 md:z-0 ${
					isSidebarOpen ? "translate-x-0" : "-translate-x-full"
				}`}
			>
				<Sidebar />
			</div>

			{/* Main content */}
			<div className="flex-1 flex flex-col min-w-0 bg-kumo-base">
				<Header />
				<main className="flex-1 overflow-hidden">
					<Outlet />
				</main>
			</div>

			{isAgentOpen && mailboxId && (
				<AgentPanel key={mailboxId} mailboxId={mailboxId} close={closeAgent} />
			)}
			<ComposeEmail />
		</div>
	);
}
