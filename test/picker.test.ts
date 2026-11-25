import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
	SessionListing,
	SessionSelectorEntry,
} from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/session-selector";
import { pickSourceSession } from "../src/picker.ts";


function session(id: string, file: string, title: string): SessionSelectorEntry {
	return {
		id,
		path: file,
		cwd: `/isolated/projects/${id}`,
		title,
		modified: new Date("2026-01-01T00:00:00Z"),
		size: 1,
		firstMessage: `${title} prompt`,
		allMessagesText: `${title} prompt`,
	};
}

function api(
	listForPicker: () => Promise<SessionListing<SessionSelectorEntry>>,
	listAllForPicker: () => Promise<SessionListing<SessionSelectorEntry>>,
): ExtensionAPI {
	return { pi: { SessionManager: { listForPicker, listAllForPicker } } } as unknown as ExtensionAPI;
}

function context(select: ExtensionContext["ui"]["select"], current: SessionSelectorEntry): ExtensionContext {
	return {
		hasUI: true,
		mode: "tui",
		cwd: "/isolated/projects/current",
		sessionManager: {
			getSessionId: () => current.id,
			getSessionFile: () => current.path,
		},
		ui: { select },
	} as unknown as ExtensionContext;
}

test("uses the host selector and awaits complete current-folder session listings", async () => {
	const current = session("parent", "/isolated/sessions/parent.jsonl", "Parent session");
	const local = session("local", "/isolated/sessions/local.jsonl", "Local topic");
	const select: ExtensionContext["ui"]["select"] = async (_title, options) => {
		const labels = options.map(option => (typeof option === "string" ? option : option.label));
		expect(labels[0]).toBe("Search all projects");
		expect(labels).toContain("Local topic (local)");
		expect(labels).not.toContain("Parent session (parent)");
		return "Local topic (local)";
	};
	const extension = api(
		async () => ({ sessions: [], complete: Promise.resolve([current, local]) }),
		async () => {
			throw new Error("The all-project listing should not be requested.");
		},
	);

	expect(await pickSourceSession(extension, context(select, current))).toBe(local.path);
});

test("offers complete all-project search without returning the current session", async () => {
	const current = session("parent", "/isolated/sessions/parent.jsonl", "Parent session");
	const local = session("local", "/isolated/sessions/local.jsonl", "Local topic");
	const remote = session("remote", "/isolated/other/remote.jsonl", "Remote topic");
	let selection = 0;
	const select: ExtensionContext["ui"]["select"] = async (_title, options) => {
		const labels = options.map(option => (typeof option === "string" ? option : option.label));
		if (selection++ === 0) {
			expect(labels[0]).toBe("Search all projects");
			return "Search all projects";
		}
		expect(labels).toContain("Remote topic (remote)");
		expect(labels).not.toContain("Parent session (parent)");
		return "Remote topic (remote)";
	};
	const extension = api(
		async () => ({ sessions: [local], complete: Promise.resolve([current, local]) }),
		async () => ({ sessions: [remote], complete: Promise.resolve([current, local, remote]) }),
	);

	expect(await pickSourceSession(extension, context(select, current))).toBe(remote.path);
});
