import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import toolDescription from "./prompts/tool.md" with { type: "text" };
import { SeanceRuntime, type SeanceReply, type SeanceSummary } from "./runtime.ts";

interface RuntimeSlot {
	runtime: SeanceRuntime;
	ownerSessionId: string | undefined;
	controller: AbortController;
	disposal: Promise<void> | undefined;
}

type SeanceAction = "spawn" | "ask" | "list" | "close";
type OptionalField = "sourceSession" | "name" | "model" | "id" | "question";

interface SeanceActionParams {
	action: SeanceAction;
	sourceSession?: string;
	name?: string;
	model?: string;
	id?: string;
	question?: string;
}

type SeanceToolDetails =
	| { action: "spawn"; child: SeanceSummary; reply?: string }
	| { action: "ask"; child: SeanceSummary; reply: string }
	| { action: "list"; children: SeanceSummary[] }
	| { action: "close"; child: SeanceSummary };

function createSlot(api: ExtensionAPI, ownerSessionId?: string): RuntimeSlot {
	return {
		runtime: new SeanceRuntime(api.pi),
		ownerSessionId,
		controller: new AbortController(),
		disposal: undefined,
	};
}

function disposeSlot(slot: RuntimeSlot): Promise<void> {
	slot.controller.abort();
	const disposal = slot.disposal ?? slot.runtime.dispose();
	slot.disposal = disposal;
	return disposal;
}

function serialize(value: unknown): string {
	const text = JSON.stringify(value, null, 2);
	if (text === undefined) throw new Error("Could not serialize the Seance result.");
	return text;
}

function requiredValue(action: string, field: string, value: string | undefined): string {
	if (value === undefined || value.trim().length === 0) {
		throw new Error(`seance action "${action}" requires a non-empty "${field}".`);
	}
	return value;
}

function rejectFields(
	params: SeanceActionParams,
	action: string,
	fields: readonly OptionalField[],
): void {
	const field = fields.find(candidate => params[candidate] !== undefined);
	if (field !== undefined) throw new Error(`seance action "${action}" does not accept "${field}".`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isCurrentSlot(slot: RuntimeSlot, ctx: ExtensionContext, current: RuntimeSlot): boolean {
	return (
		current === slot &&
		!slot.controller.signal.aborted &&
		slot.ownerSessionId === ctx.sessionManager.getSessionId()
	);
}

function assertCurrentSlot(slot: RuntimeSlot, ctx: ExtensionContext, current: RuntimeSlot, signal: AbortSignal): void {
	signal.throwIfAborted();
	if (!isCurrentSlot(slot, ctx, current)) {
		throw new DOMException("The parent session changed during the Seance operation.", "AbortError");
	}
}

async function discardSpawnedChild(slot: RuntimeSlot, ctx: ExtensionContext, current: RuntimeSlot, id: string): Promise<void> {
	if (current !== slot || slot.controller.signal.aborted) {
		await disposeSlot(slot);
		return;
	}
	try {
		await slot.runtime.close(ctx, id);
	} catch {
		await disposeSlot(slot);
	}
}

const seanceExtension: ExtensionFactory = (api: ExtensionAPI) => {
	let currentSlot = createSlot(api);

	const slotFor = async (ctx: ExtensionContext): Promise<RuntimeSlot> => {
		const ownerSessionId = ctx.sessionManager.getSessionId();
		const previous = currentSlot;
		if (previous.ownerSessionId === ownerSessionId) return previous;
		if (previous.ownerSessionId === undefined) {
			previous.ownerSessionId = ownerSessionId;
			return previous;
		}
		const next = createSlot(api, ownerSessionId);
		currentSlot = next;
		await disposeSlot(previous);
		return next;
	};

	const parameters = api.zod
		.object({
			action: api.zod.enum(["spawn", "ask", "list", "close"]).describe("Operation to perform."),
			sourceSession: api.zod
				.string()
				.describe("Required for spawn: non-current live session ID, saved-session ID or unambiguous prefix, or JSONL path.")
				.optional(),
			name: api.zod.string().describe("Optional label for a newly spawned child.").optional(),
			model: api.zod
				.string()
				.describe("Optional provider/model ID override for a newly spawned child.")
				.optional(),
			id: api.zod.string().describe("Required for ask or close: the attached child ID.").optional(),
			question: api.zod
				.string()
				.describe("Required for ask; optional initial question for spawn.")
				.optional(),
		})
		.strict();

	const tool: ToolDefinition<typeof parameters, SeanceToolDetails> = {
		name: "seance",
		label: "Seance",
		description: toolDescription,
		parameters,
		approval: "read",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const slot = await slotFor(ctx);
			const operationSignal = signal
				? AbortSignal.any([signal, slot.controller.signal])
				: slot.controller.signal;
			assertCurrentSlot(slot, ctx, currentSlot, operationSignal);

			switch (params.action) {
				case "spawn": {
					rejectFields(params, "spawn", ["id"]);
					const sourceSession = requiredValue("spawn", "sourceSession", params.sourceSession);
					const question = params.question === undefined ? undefined : requiredValue("spawn", "question", params.question);
					const child = await slot.runtime.spawn(
						ctx,
						{
							sourceSession,
							...(params.name === undefined ? {} : { name: params.name }),
							...(params.model === undefined ? {} : { model: params.model }),
						},
						operationSignal,
					);
					try {
						assertCurrentSlot(slot, ctx, currentSlot, operationSignal);
						if (question === undefined) {
							return {
								content: [{ type: "text", text: serialize(child) }],
								details: { action: "spawn", child },
							};
						}
						const answer = await slot.runtime.ask(ctx, child.id, question, operationSignal);
						assertCurrentSlot(slot, ctx, currentSlot, operationSignal);
						const { reply, ...summary } = answer;
						return {
							content: [{ type: "text", text: serialize(answer) }],
							details: { action: "spawn", child: summary, reply },
						};
					} catch (error) {
						if (operationSignal.aborted || !isCurrentSlot(slot, ctx, currentSlot)) {
							await discardSpawnedChild(slot, ctx, currentSlot, child.id);
						}
						throw error;
					}
				}
				case "ask": {
					rejectFields(params, "ask", ["sourceSession", "name", "model"]);
					const id = requiredValue("ask", "id", params.id);
					const question = requiredValue("ask", "question", params.question);
					const answer: SeanceReply = await slot.runtime.ask(ctx, id, question, operationSignal);
					assertCurrentSlot(slot, ctx, currentSlot, operationSignal);
					const { reply, ...child } = answer;
					return {
						content: [{ type: "text", text: reply }],
						details: { action: "ask", child, reply },
					};
				}
				case "list": {
					rejectFields(params, "list", ["sourceSession", "name", "model", "id", "question"]);
					const children = slot.runtime.list(ctx);
					assertCurrentSlot(slot, ctx, currentSlot, operationSignal);
					return {
						content: [{ type: "text", text: serialize(children) }],
						details: { action: "list", children },
					};
				}
				case "close": {
					rejectFields(params, "close", ["sourceSession", "name", "model", "question"]);
					const id = requiredValue("close", "id", params.id);
					const child = await slot.runtime.close(ctx, id);
					assertCurrentSlot(slot, ctx, currentSlot, operationSignal);
					return {
						content: [{ type: "text", text: serialize(child) }],
						details: { action: "close", child },
					};
				}
			}
		},
	};

	api.registerTool(tool);

	api.registerCommand("seance", {
		description: "Attach a read-only Seance child from a saved historical session.",
		async handler(args, ctx): Promise<void> {
			const slot = await slotFor(ctx);
			const operationSignal = slot.controller.signal;
			let sourceSession = args.trim();
			if (sourceSession.length === 0) {
				if (!isCurrentSlot(slot, ctx, currentSlot)) return;
				if (!ctx.hasUI) {
					ctx.ui.notify("Use /seance <non-current session ID or JSONL path> outside the interactive UI.", "error");
					return;
				}
				let input: string | undefined;
				try {
					input = await ctx.ui.input("Non-current session ID or JSONL path");
				} catch (error) {
					if (isCurrentSlot(slot, ctx, currentSlot)) {
						ctx.ui.notify(`Could not choose a session: ${errorMessage(error)}`, "error");
					}
					return;
				}
				if (!isCurrentSlot(slot, ctx, currentSlot)) return;
				if (input === undefined) return;
				sourceSession = input.trim();
			}
			if (sourceSession.length === 0) {
				ctx.ui.notify("Provide a non-current session ID or JSONL path to attach.", "error");
				return;
			}

			try {
				const child = await slot.runtime.spawn(ctx, { sourceSession }, operationSignal);
				if (!isCurrentSlot(slot, ctx, currentSlot)) {
					await discardSpawnedChild(slot, ctx, currentSlot, child.id);
					return;
				}
				try {
					api.sendMessage(
						{
							customType: "omp-seance-attachment",
							content: serialize(child),
							display: true,
							attribution: "agent",
							details: {
								id: child.id,
								sourceSession: child.sourceSession,
								sessionFile: child.sessionFile,
								status: child.status,
								model: child.model,
							},
						},
						{ triggerTurn: false },
					);
				} catch (error) {
					await discardSpawnedChild(slot, ctx, currentSlot, child.id);
					throw error;
				}
				if (isCurrentSlot(slot, ctx, currentSlot)) {
					ctx.ui.notify(`Attached Seance child ${child.id}.`, "info");
				}
			} catch (error) {
				if (operationSignal.aborted || !isCurrentSlot(slot, ctx, currentSlot)) return;
				ctx.ui.notify(`Could not attach Seance child: ${errorMessage(error)}`, "error");
			}
		},
	});

	api.on("session_start", async (_event, ctx) => {
		await slotFor(ctx);
	});

	api.on("session_switch", async (_event, ctx) => {
		const previous = currentSlot;
		currentSlot = createSlot(api, ctx.sessionManager.getSessionId());
		await disposeSlot(previous);
	});

	api.on("session_shutdown", async () => {
		const previous = currentSlot;
		currentSlot = createSlot(api);
		await disposeSlot(previous);
	});
};

export default seanceExtension;
