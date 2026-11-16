import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionInfo } from "@oh-my-pi/pi-coding-agent";
import { SessionSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-selector";

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
