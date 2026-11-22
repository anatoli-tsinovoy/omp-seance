import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentDefinition, AgentSession, ExtensionAPI, ExtensionContext, SessionManager } from "@oh-my-pi/pi-coding-agent";
import consultantPrompt from "./prompts/consultant.md" with { type: "text" };
import { assertSafeForkDestination, resolveSourceSession } from "./source.ts";

type SDK = ExtensionAPI["pi"];

const consultantAgent: AgentDefinition = {
	name: "seance",
	description: "Read-only historical-session consultant.",
	systemPrompt: consultantPrompt,
	tools: ["read", "grep", "glob", "yield"],
	source: "bundled",
};

export interface SeanceSummary {
	id: string;
	sourceSession: string;
	sessionFile: string;
	status: "idle" | "running" | "closed";
	model: string;
	cwd: string;
	sourceCwd: string;
	sourceCwdAvailable: boolean;
}

interface Consultant {
	summary: SeanceSummary;
	session: AgentSession;
	unsubscribe: () => void;
	closing?: Promise<void>;
}

export class SeanceRuntime {
	#sdk: SDK;
	#children = new Map<string, Consultant>();
	#pending = new Set<Promise<SeanceSummary>>();
	#owner?: string;
	#disposed = false;

	constructor(sdk: SDK) {
		this.#sdk = sdk;
	}

	#assertOwner(ctx: ExtensionContext): void {
		if (this.#disposed) throw new Error("This Seance runtime is closed.");
		const owner = ctx.sessionManager.getSessionId();
		this.#owner ??= owner;
		if (owner !== this.#owner) throw new Error("This consultant belongs to a different parent session.");
	}

	#summary(child: Consultant): SeanceSummary {
		return { ...child.summary, status: child.closing ? "closed" : child.session.isStreaming ? "running" : "idle" };
	}

	async spawn(
		ctx: ExtensionContext,
		options: { sourceSession: string; name?: string; model?: string; question?: string },
		signal?: AbortSignal,
	): Promise<SeanceSummary> {
		this.#assertOwner(ctx);
		const pending = this.#spawn(ctx, options, signal);
		this.#pending.add(pending);
		try {
			return await pending;
		} finally {
			this.#pending.delete(pending);
		}
	}

	async #spawn(
		ctx: ExtensionContext,
		options: { sourceSession: string; name?: string; model?: string; question?: string },
		signal?: AbortSignal,
	): Promise<SeanceSummary> {
		signal?.throwIfAborted();
		const question = options.question?.trim() ? options.question : undefined;
		const artifacts = ctx.sessionManager.getArtifactsDir();
		if (!ctx.sessionManager.getSessionFile() || !artifacts) throw new Error("Seance requires a persistent parent session.");
		const source = await resolveSourceSession(this.#sdk, ctx, options.sourceSession);
		const registry = this.#sdk.AgentRegistry.global();
		const parentSession = registry.get(ctx.agent.id)?.session;
		if (!(parentSession instanceof this.#sdk.AgentSession)) {
			throw new Error("The live parent session is unavailable for Seance.");
		}
		const asyncJobManager = parentSession.asyncJobManager;
		if (!asyncJobManager) {
			throw new Error("The parent session's async job manager is unavailable for Seance wake-turn results.");
		}
		let id: string;
		do {
			id = `Seance${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
		} while (registry.get(id));
		const sessionFile = path.join(artifacts, `${id}.jsonl`);
		await assertSafeForkDestination(source.file, sessionFile);
		const selector = options.model?.trim();
		const model = selector
			? ctx.models.list().find(candidate => `${candidate.provider}/${candidate.id}` === selector)
			: ctx.model;
		if (!model)
			throw new Error(selector ? `Model "${selector}" is not an available exact provider/model ID.` : "Select a model in the parent session first.");
		signal?.throwIfAborted();
		this.#assertOwner(ctx);
		const sourceCwdAvailable = path.isAbsolute(source.cwd) &&
			(await fs.stat(source.cwd).then(stat => stat.isDirectory(), () => false));
		let cwd = source.cwd;
		let manager: SessionManager | undefined;
		let session: AgentSession | undefined;
		let unsubscribe: (() => void) | undefined;
		try {
			if (!sourceCwdAvailable) {
				const childArtifacts = sessionFile.slice(0, -6);
				await fs.mkdir(childArtifacts, { recursive: true });
				cwd = await fs.mkdtemp(path.join(childArtifacts, ".unavailable-source-"));
			}
			manager = await this.#sdk.SessionManager.forkFrom(source.file, cwd, artifacts, undefined, {
				sessionFile,
				copyArtifacts: true,
				suppressBreadcrumb: true,
				resetInheritedCost: true,
				repairInterruptedTail: true,
			});
			await manager.setAdditionalDirectories([]);
			for (const entry of manager.getEntries()) {
				if (entry.type === "session_init") entry.isolated = true;
			}
			manager.appendMessage({
				role: "user",
				content: [{
					type: "text",
					text: JSON.stringify({
						seanceSource: { file: source.file, recordedCwd: source.cwd, workingDirectory: cwd, sourceCwdAvailable },
					}),
				}],
				timestamp: Date.now(),
			});
			await manager.rewriteEntries();
			await manager.setTaskPromptCacheKey(crypto.randomUUID());
			signal?.throwIfAborted();
			this.#assertOwner(ctx);
			({ session } = await this.#sdk.createAgentSession({
				cwd,
				sessionManager: manager,
				model,
				modelRegistry: ctx.modelRegistry,
				modelRole: "default",
				agentRegistry: registry,
				asyncJobManager,
				agentId: id,
				parentTaskPrefix: id,
				agentDisplayName: options.name?.trim() || id,
				parentAgentId: ctx.agent.id,
				taskDepth: ctx.agent.depth + 1,
				systemPrompt: consultantPrompt,
				restrictToolNames: true,
				toolNames: ["read", "grep", "glob", "yield"],
				requireYieldTool: true,
				enableMCP: false,
				enableLsp: false,
				disableExtensionDiscovery: true,
				additionalDirectories: [],
				skills: [],
				rules: [],
				contextFiles: [],
				noContextFiles: true,
				promptTemplates: [],
				slashCommands: [],
			}));
			signal?.throwIfAborted();
			this.#assertOwner(ctx);
			const statusUnsubscribe = registry.syncSessionStatus(id, session);
			unsubscribe = statusUnsubscribe;
			const resolvedModel = `${model.provider}/${model.id}`;
			registry.setHistory(id, { agent: "seance", readOnly: true, resolvedModel }, sessionFile);
			registry.setStatus(id, "idle", session);
			this.#sdk.attachIrcWakeTurnMonitor(session, {
				id,
				agent: consultantAgent,
				description: consultantAgent.description,
				...(selector ? { modelOverride: selector } : {}),
				modelRole: "default",
				artifactsDir: artifacts,
			});
			const child: Consultant = {
				summary: {
					id,
					sourceSession: source.file,
					sessionFile,
					status: "idle",
					model: resolvedModel,
					cwd,
					sourceCwd: source.cwd,
					sourceCwdAvailable,
				},
				session,
				unsubscribe: statusUnsubscribe,
			};
			this.#children.set(id, child);
			if (question !== undefined) {
				signal?.throwIfAborted();
				this.#assertOwner(ctx);
				await session.deliverIrcMessage({
					id: crypto.randomUUID(),
					from: ctx.agent.id,
					to: id,
					body: question,
					ts: Date.now(),
				});
				signal?.throwIfAborted();
				this.#assertOwner(ctx);
			}
			return this.#summary(child);
		} catch (error) {
			this.#children.delete(id);
			if (session) {
				session.setIrcWakeTurnObserver(undefined);
				unsubscribe?.();
				registry.unregister(id, session);
				await session.dispose();
			} else {
				const ref = registry.get(id);
				if (ref?.sessionFile === sessionFile) registry.unregister(id, ref);
				await manager?.close();
			}
			throw error;
		}
	}

	#child(ctx: ExtensionContext, id: string): Consultant {
		this.#assertOwner(ctx);
		const child = this.#children.get(id);
		if (!child || child.closing || this.#sdk.AgentRegistry.global().get(id)?.session !== child.session) {
			throw new Error(`No live Seance child "${id}" belongs to this session.`);
		}
		return child;
	}

	async #closeChild(child: Consultant): Promise<void> {
		if (child.closing) return child.closing;
		child.closing = (async () => {
			child.unsubscribe();
			this.#children.delete(child.summary.id);
			child.session.setIrcWakeTurnObserver(undefined);
			this.#sdk.AgentRegistry.global().unregister(child.summary.id, child.session);
			try {
				await child.session.abort();
			} finally {
				await child.session.dispose();
			}
		})();
		return child.closing;
	}

	async close(ctx: ExtensionContext, id: string): Promise<SeanceSummary> {
		const child = this.#child(ctx, id);
		await this.#closeChild(child);
		return { ...child.summary, status: "closed" };
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		await Promise.allSettled(this.#pending);
		await Promise.all([...this.#children.values()].map(child => this.#closeChild(child)));
	}
}
