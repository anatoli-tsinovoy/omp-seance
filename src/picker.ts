import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionInfo } from "@oh-my-pi/pi-coding-agent";
import { SessionSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-selector";
import { resolveSourceSession } from "./source.ts";

export async function pickSourceSession(
	api: ExtensionAPI,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui") return undefined;

	const currentSessionId = ctx.sessionManager.getSessionId();
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	const currentSessionPath = currentSessionFile ? path.resolve(currentSessionFile) : undefined;
	const filterCurrentSession = (sessions: SessionInfo[]): SessionInfo[] =>
		sessions.filter(
			session =>
				session.id !== currentSessionId &&
				(currentSessionPath === undefined || path.resolve(session.path) !== currentSessionPath),
		);

	try {
		signal?.throwIfAborted();
		const folder = await api.pi.SessionManager.listForPicker(ctx.cwd);
		signal?.throwIfAborted();
		const result = await ctx.ui.custom<SessionInfo | undefined>(
			(tui, _theme, _keybindings, done) => {
				const picker = new SessionSelectorComponent(
					filterCurrentSession(folder.sessions),
					session => done(session),
					() => done(undefined),
					() => done(undefined),
					{
						title: "Select a session for Seance",
						...(folder.complete === undefined
							? {}
							: { completeSessions: folder.complete.then(filterCurrentSession) }),
						loadAllSessions: async () => {
							const all = await api.pi.SessionManager.listAllForPicker();
							return {
								sessions: filterCurrentSession(all.sessions),
								...(all.complete === undefined
									? {}
									: { complete: all.complete.then(filterCurrentSession) }),
							};
						},
					},
				);
				picker.setOnRequestRender(() => tui.requestRender());
				return picker;
			},
			{ overlay: true, ...(signal === undefined ? {} : { signal }) },
		);
		return signal?.aborted ? undefined : result?.path;
	} catch (error) {
		if (signal?.aborted) return undefined;
		throw error;
	}
}

export async function pickConsultationOptions(
	api: ExtensionAPI,
	ctx: ExtensionContext,
	sourceSession: string,
	signal: AbortSignal,
): Promise<{ model?: string; question?: string } | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui") return undefined;

	const ownerSessionId = ctx.sessionManager.getSessionId();
	const isCurrentOwner = () => !signal.aborted && ctx.sessionManager.getSessionId() === ownerSessionId;

	try {
		if (!isCurrentOwner()) return undefined;

		let historicalModelSelector: string | undefined;
		const resolvedSource = await resolveSourceSession(api.pi, ctx, sourceSession);
		if (!isCurrentOwner()) return undefined;
		const sourceManager = await api.pi.SessionManager.open(resolvedSource.file, undefined, undefined, {
			suppressBreadcrumb: true,
			throwIfMissing: true,
		});
		try {
			if (!isCurrentOwner()) return undefined;
			const sourceContext = sourceManager.buildSessionContext();
			historicalModelSelector = api.pi.getRestorableSessionModels(
				sourceContext.models,
				sourceManager.getLastModelChangeRole(),
			)[0];
		} finally {
			await sourceManager.close();
		}
		if (!isCurrentOwner()) return undefined;

		const availableModels = ctx.models.list();
		const selectorFor = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
		const availableBySelector = new Map(availableModels.map(model => [selectorFor(model), model]));
		const currentModel = ctx.models.current();
		const currentSelector = currentModel ? selectorFor(currentModel) : undefined;
		const resolvedHistoricalModel = historicalModelSelector
			? ctx.models.resolve(historicalModelSelector)
			: undefined;
		const historicalAvailableSelector =
			resolvedHistoricalModel &&
				selectorFor(resolvedHistoricalModel) === historicalModelSelector &&
				availableBySelector.has(historicalModelSelector)
				? historicalModelSelector
				: undefined;
		const historicalUnavailable = historicalModelSelector !== undefined && historicalAvailableSelector === undefined;
		const unavailableNotice =
			historicalUnavailable && historicalModelSelector
				? `Source model ${historicalModelSelector} is unavailable. Choose a model for this consultation`
				: "Choose a model for this consultation";

		const modelChoices: { label: string; description?: string }[] = [];
		const quickChoiceSelectors = new Set<string>();
		if (currentSelector) {
			const currentAvailable = availableBySelector.has(currentSelector);
			modelChoices.push({
				label: currentSelector,
				description:
					historicalAvailableSelector === currentSelector
						? "Current and source session model"
						: currentAvailable
							? "Current session model"
							: "Current session model (not in the available-model list)",
			});
			quickChoiceSelectors.add(currentSelector);
		}
		if (historicalAvailableSelector && historicalAvailableSelector !== currentSelector) {
			modelChoices.push({
				label: historicalAvailableSelector,
				description: "Source session model",
			});
			quickChoiceSelectors.add(historicalAvailableSelector);
		}

		const otherModels = availableModels.filter(model => !quickChoiceSelectors.has(selectorFor(model)));
		const chooseAnotherLabel = "Choose another available model";
		if (modelChoices.length > 0 && otherModels.length > 0) {
			modelChoices.push({
				label: chooseAnotherLabel,
				description: `${otherModels.length} other available model${otherModels.length === 1 ? "" : "s"}`,
			});
		} else if (modelChoices.length === 0) {
			modelChoices.push(
				...availableModels.map(model => ({
					label: selectorFor(model),
					description: model.name,
				})),
			);
		}

		let selectedModel: string | undefined;
		if (modelChoices.length > 0) {
			const choice = await ctx.ui.select(unavailableNotice, modelChoices, {
				initialIndex: 0,
				signal,
			});
			if (!isCurrentOwner() || choice === undefined) return undefined;

			if (choice === chooseAnotherLabel) {
				const otherChoice = await ctx.ui.select(
					"Choose another available model",
					otherModels.map(model => ({
						label: selectorFor(model),
						description: model.name,
					})),
					{ initialIndex: 0, signal },
				);
				if (!isCurrentOwner() || otherChoice === undefined) return undefined;
				selectedModel = otherChoice;
			} else {
				if (choice !== currentSelector) selectedModel = choice;
			}
		} else if (historicalUnavailable && historicalModelSelector) {
			ctx.ui.notify(`Source model ${historicalModelSelector} is unavailable, and no model choices are available.`, "warning");
		}

		if (!isCurrentOwner()) return undefined;
		const question = await ctx.ui.editor(
			"Question for Seance (leave blank to attach without a question)",
			"",
			{ signal },
		);
		if (!isCurrentOwner() || question === undefined) return undefined;

		return {
			...(selectedModel === undefined ? {} : { model: selectedModel }),
			...(question.trim().length === 0 ? {} : { question }),
		};
	} catch (error) {
		if (!isCurrentOwner()) return undefined;
		throw error;
	}
}
