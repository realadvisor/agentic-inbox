import { useState } from "react";
import { Popover } from "@cloudflare/kumo";
import {
	CaretDownIcon,
	CheckIcon,
	CpuIcon,
	MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import type { AgentCatalogModel } from "../../shared/agent";

export default function AgentModelPicker({
	models,
	value,
	defaultModel,
	disabled,
	onChange,
	context = "chat",
	portalContainer,
}: {
	context?: "chat" | "draft";
	portalContainer?: HTMLElement | null;
	models: AgentCatalogModel[];
	value: string;
	defaultModel: string;
	disabled: boolean;
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const selected = models.find((m) => m.id === (value || defaultModel));
	const visible = models
		.filter(
			(m) =>
				m.available &&
				`${m.name} ${m.provider}`.toLowerCase().includes(search.toLowerCase()),
		)
		.sort((a, b) => Number(b.selectable) - Number(a.selectable));
	const choose = (id: string) => {
		onChange(id);
		setOpen(false);
	};
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) setSearch("");
			}}
		>
			<Popover.Trigger
				render={
					<button
						type="button"
						className="agent-model-trigger"
						disabled={disabled}
						aria-label="Choose agent model"
					/>
				}
			>
				<CpuIcon size={14} />
				<span>{selected?.name || value || "Choose model"}</span>
				<CaretDownIcon size={11} />
			</Popover.Trigger>
			<Popover.Content
				align="start"
				className="agent-model-menu"
				container={portalContainer ?? undefined}
			>
				<Popover.Title className="agent-model-title">
					Choose a model
				</Popover.Title>
				<div className="agent-model-search">
					<MagnifyingGlassIcon size={15} />
					<input
						autoFocus
						aria-label="Search chat models"
						placeholder="Search models…"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
				</div>
				<div className="agent-model-options">
					{!search && (
						<button
							type="button"
							className="agent-model-option"
							onClick={() => choose("")}
							aria-pressed={!value}
						>
							<div>
								<strong>
									{context === "draft"
										? "Use default model"
										: "Use mailbox default"}
								</strong>
								<small>
									{models.find((m) => m.id === defaultModel)?.name ??
										defaultModel}
								</small>
							</div>
							{!value && <CheckIcon size={15} />}
						</button>
					)}
					{visible.map((model) => (
						<button
							type="button"
							className="agent-model-option"
							key={model.id}
							disabled={!model.selectable}
							aria-pressed={value === model.id}
							onClick={() => choose(model.id)}
						>
							<div>
								<strong>{model.name}</strong>
								<small>
									{model.provider}
									{!model.selectable ? " · Not configured" : ""}
								</small>
							</div>
							{value === model.id && <CheckIcon size={15} />}
						</button>
					))}
					{!visible.length && (
						<p className="agent-model-empty">No matching models</p>
					)}
				</div>
				<p className="agent-model-footnote">
					Applies to this {context}. Your default stays unchanged.
				</p>
			</Popover.Content>
		</Popover>
	);
}
