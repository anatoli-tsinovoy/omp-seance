import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionSelectorEntry } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/session-selector";
import { resolveSourceSession } from "./source.ts";

function createSessionChoices(sessions: SessionSelectorEntry[]) {
	const labels = new Set<string>();
	const sessionsByLabel = new Map<string, SessionSelectorEntry>();
	const options = sessions.map(session => {
		const displayName = session.title?.trim() || session.firstMessage.replace(/\s+/g, " ").trim() || session.id;
		const baseLabel = `${displayName} (${session.id})`;
		let label = baseLabel;
		if (labels.has(label)) label = `${baseLabel} - ${session.path}`;
		let suffix = 2;
		while (labels.has(label)) label = `${baseLabel} - ${session.path} (${suffix++})`;
		labels.add(label);
		sessionsByLabel.set(label, session);
		return { label, description: `${session.cwd} - ${session.path}` };
	});
	return { options, sessionsByLabel };
}

export async function pickSourceSession(
	api: ExtensionAPI,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui") return undefined;

	const currentSessionId = ctx.sessionManager.getSessionId();
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	const currentSessionPath = currentSessionFile ? path.resolve(currentSessionFile) : undefined;
	const filterCurrentSession = (sessions: SessionSelectorEntry[]): SessionSelectorEntry[] =>
		sessions.filter(
			session =>
				session.id !== currentSessionId &&
				(currentSessionPath === undefined || path.resolve(session.path) !== currentSessionPath),
		);

	const searchAllLabel = "Search all projects";
	try {
		signal?.throwIfAborted();
		const folder = await api.pi.SessionManager.listForPicker(ctx.cwd);
		const folderSessions = folder.complete ? await folder.complete : folder.sessions;
		const folderChoices = createSessionChoices(filterCurrentSession(folderSessions));
		const choice = await ctx.ui.select(
			"Select a session for Seance",
			[
				{ label: searchAllLabel, description: "Search sessions saved in every project" },
				...folderChoices.options,
			],
			signal === undefined ? undefined : { signal },
		);
		if (signal?.aborted || choice === undefined) return undefined;
		if (choice !== searchAllLabel) return folderChoices.sessionsByLabel.get(choice)?.path;

		signal?.throwIfAborted();
		const allProjects = await api.pi.SessionManager.listAllForPicker();
		const allSessions = allProjects.complete ? await allProjects.complete : allProjects.sessions;
		const allChoices = createSessionChoices(filterCurrentSession(allSessions));
		if (signal?.aborted) return undefined;
		const allChoice = await ctx.ui.select(
			"Select a session from all projects",
			allChoices.options,
			signal === undefined ? undefined : { signal },
		);
		return signal?.aborted || allChoice === undefined ? undefined : allChoices.sessionsByLabel.get(allChoice)?.path;
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
