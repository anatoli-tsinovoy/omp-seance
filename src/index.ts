import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import toolDescription from "./prompts/tool.md" with { type: "text" };
import { SeanceRuntime, type SeanceSummary } from "./runtime.ts";
import { pickSourceSession } from "./picker.ts";

interface RuntimeSlot {
	runtime: SeanceRuntime;
	ownerSessionId: string | undefined;
	controller: AbortController;
	disposal: Promise<void> | undefined;
}

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
			sourceSession: api.zod
				.string()
				.refine(value => value.trim().length > 0, "A non-empty source session is required.")
				.describe("Non-current live session ID, saved-session ID or unambiguous prefix, or JSONL path."),
			name: api.zod.string().describe("Optional label for the new child.").optional(),
			model: api.zod.string().describe("Optional exact provider/model ID override.").optional(),
		})
		.strict();

	const tool: ToolDefinition<typeof parameters, SeanceSummary> = {
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

			const child = await slot.runtime.spawn(
				ctx,
				{
					sourceSession: params.sourceSession,
					...(params.name === undefined ? {} : { name: params.name }),
					...(params.model === undefined ? {} : { model: params.model }),
				},
				operationSignal,
			);
			try {
				assertCurrentSlot(slot, ctx, currentSlot, operationSignal);
				return {
					content: [{ type: "text", text: serialize(child) }],
					details: child,
				};
			} catch (error) {
				if (operationSignal.aborted || !isCurrentSlot(slot, ctx, currentSlot)) {
					await discardSpawnedChild(slot, ctx, currentSlot, child.id);
				}
				throw error;
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
				if (!ctx.hasUI || ctx.mode !== "tui") {
					ctx.ui.notify(
						"Use /seance <non-current session ID or JSONL path> outside the interactive TUI.",
						"error",
					);
					return;
				}
				try {
					const selected = await pickSourceSession(api, ctx, operationSignal);
					if (!isCurrentSlot(slot, ctx, currentSlot)) return;
					if (selected === undefined) return;
					sourceSession = selected;
				} catch (error) {
					if (isCurrentSlot(slot, ctx, currentSlot)) {
						ctx.ui.notify(`Could not choose a session: ${errorMessage(error)}`, "error");
					}
					return;
				}
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
							details: child,
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
