import * as path from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext, SessionManager } from "@oh-my-pi/pi-coding-agent";
import consultantPrompt from "./prompts/consultant.md" with { type: "text" };
import { assertSafeForkDestination, resolveSourceSession } from "./source.ts";

type SDK = ExtensionAPI["pi"];

export interface SeanceSummary {
	id: string;
	sourceSession: string;
	sessionFile: string;
	status: "idle" | "running" | "closed";
	model: string;
}

export interface SeanceReply extends SeanceSummary {
	reply: string;
}

interface Consultant {
	summary: SeanceSummary;
	session: AgentSession;
	unsubscribe: () => void;
	busy: boolean;
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
		return { ...child.summary, status: child.closing ? "closed" : child.busy || child.session.isStreaming ? "running" : "idle" };
	}

	async spawn(
		ctx: ExtensionContext,
		options: { sourceSession: string; name?: string; model?: string },
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
		options: { sourceSession: string; name?: string; model?: string },
		signal?: AbortSignal,
	): Promise<SeanceSummary> {
		signal?.throwIfAborted();
		const artifacts = ctx.sessionManager.getArtifactsDir();
		if (!ctx.sessionManager.getSessionFile() || !artifacts) throw new Error("Seance requires a persistent parent session.");
		const source = await resolveSourceSession(this.#sdk, ctx, options.sourceSession);
		const registry = this.#sdk.AgentRegistry.global();
		let id: string;
		do { id = `Seance${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`; } while (registry.get(id));
		const sessionFile = path.join(artifacts, `${id}.jsonl`);
		await assertSafeForkDestination(source, sessionFile);
		const selector = options.model?.trim();
		const model = selector
			? ctx.models.list().find(candidate => `${candidate.provider}/${candidate.id}` === selector)
			: ctx.model;
		if (!model) throw new Error(selector ? `Model "${selector}" is not an available exact provider/model ID.` : "Select a model in the parent session first.");
		signal?.throwIfAborted();
		this.#assertOwner(ctx);
		let manager: SessionManager | undefined;
		let session: AgentSession | undefined;
		try {
			manager = await this.#sdk.SessionManager.forkFrom(source, ctx.cwd, artifacts, undefined, {
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
			await manager.rewriteEntries();
			await manager.setTaskPromptCacheKey(crypto.randomUUID());
			signal?.throwIfAborted();
			this.#assertOwner(ctx);
			({ session } = await this.#sdk.createAgentSession({
				cwd: ctx.cwd,
				sessionManager: manager,
				model,
				modelRegistry: ctx.modelRegistry,
				modelRole: "default",
				agentRegistry: registry,
				agentId: id,
				agentDisplayName: options.name?.trim() || id,
				parentAgentId: ctx.agent.id,
				taskDepth: ctx.agent.depth + 1,
				systemPrompt: consultantPrompt,
				restrictToolNames: true,
				toolNames: ["read", "grep", "glob"],
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
			const unsubscribe = registry.syncSessionStatus(id, session);
			const resolvedModel = `${model.provider}/${model.id}`;
			registry.setHistory(id, { agent: "seance", readOnly: true, resolvedModel }, sessionFile);
			registry.setStatus(id, "idle", session);
			const child: Consultant = {
				summary: { id, sourceSession: source, sessionFile, status: "idle", model: resolvedModel },
				session, unsubscribe, busy: false,
			};
			this.#children.set(id, child);
			return this.#summary(child);
		} catch (error) {
			if (session) {
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

	list(ctx: ExtensionContext): SeanceSummary[] {
		this.#assertOwner(ctx);
		return [...this.#children.values()]
			.filter(child => this.#sdk.AgentRegistry.global().get(child.summary.id)?.session === child.session)
			.map(child => this.#summary(child));
	}

	#child(ctx: ExtensionContext, id: string): Consultant {
		this.#assertOwner(ctx);
		const child = this.#children.get(id);
		if (!child || child.closing || this.#sdk.AgentRegistry.global().get(id)?.session !== child.session) {
			throw new Error(`No live Seance child "${id}" belongs to this session.`);
		}
		return child;
	}

	async ask(ctx: ExtensionContext, id: string, question: string, signal?: AbortSignal, onText?: (text: string) => void): Promise<SeanceReply> {
		const child = this.#child(ctx, id);
		if (!question.trim()) throw new Error("A non-empty consultation question is required.");
		if (child.busy || child.session.isStreaming) throw new Error(`Seance child "${id}" is already answering a question.`);
		signal?.throwIfAborted();
		child.busy = true;
		let reply: string | undefined;
		let responseError: string | undefined;
		const unsubscribe = child.session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				reply = event.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
				responseError = event.message.stopReason === "error" || event.message.stopReason === "aborted"
					? event.message.errorMessage || "The consultant did not complete its answer." : undefined;
			}
			if (onText && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				onText(event.assistantMessageEvent.delta);
			}
		});
		const abort = () => {
			void child.session.abort().catch(error => this.#sdk.logger.warn("Seance cancellation failed", { error: String(error) }));
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			await child.session.prompt(question, { expandPromptTemplates: false });
			await child.session.waitForIdle();
			signal?.throwIfAborted();
			this.#assertOwner(ctx);
			if (child.closing) throw new Error("The consultant was closed before its answer was delivered.");
			if (responseError) throw new Error(responseError);
			if (!reply?.trim()) throw new Error("The consultant returned no report.");
			this.#sdk.AgentRegistry.global().markResultAccepted(id, child.session);
			return { ...this.#summary(child), status: "idle", reply };
		} finally {
			child.busy = false;
			unsubscribe();
			signal?.removeEventListener("abort", abort);
		}
	}

	async #closeChild(child: Consultant): Promise<void> {
		if (child.closing) return child.closing;
		child.closing = (async () => {
			child.unsubscribe();
			this.#children.delete(child.summary.id);
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
