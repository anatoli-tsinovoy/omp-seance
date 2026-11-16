import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionInfo } from "@oh-my-pi/pi-coding-agent";

type SDK = ExtensionAPI["pi"];

/** Resolve existing symlinks even when the final destination does not exist yet. */
async function canonicalPath(file: string): Promise<string> {
	try {
		return await fs.realpath(file);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		const parent = path.dirname(file);
		if (parent === file) throw error;
		return path.join(await canonicalPath(parent), path.basename(file));
	}
}

export async function assertSafeForkDestination(sourceFile: string, destinationFile: string): Promise<void> {
	const source = await fs.realpath(sourceFile);
	if (!source.endsWith(".jsonl")) throw new Error("The source must be an OMP JSONL session file.");
	const sourceArtifacts = await canonicalPath(source.slice(0, -6));
	const destinationArtifacts = await canonicalPath(path.resolve(destinationFile).slice(0, -6));
	const relative = path.relative(sourceArtifacts, destinationArtifacts);
	if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
		throw new Error("Self/ancestor consultation is not supported: the fork would copy source artifacts into themselves. Select a different historical session.");
	}
}

function selectSession(sessions: SessionInfo[], query: string): string | undefined {
	const exact = sessions.filter(session => session.id === query);
	const matches = exact.length ? exact : sessions.filter(session => session.id.startsWith(query));
	const files = [...new Set(matches.map(session => path.resolve(session.path)))];
	if (files.length > 1) throw new Error(`Ambiguous session ID "${query}"; provide its full JSONL path.`);
	return files[0];
}

export interface SourceSession {
	file: string;
	cwd: string;
}

export async function resolveSourceSession(sdk: SDK, ctx: ExtensionContext, value: string): Promise<SourceSession> {
	let query = value.trim();
	if ((query.startsWith('"') && query.endsWith('"')) || (query.startsWith("'") && query.endsWith("'"))) {
		query = query.slice(1, -1);
	}
	if (!query || query === "current") throw new Error("Select a historical session ID or JSONL path; current-session consultation is not supported.");
	let file: string | undefined;
	if (query.includes("/") || query.includes("\\") || query.endsWith(".jsonl") || query.startsWith(".")) {
		if (query.startsWith("~/")) query = path.join(os.homedir(), query.slice(2));
		file = path.resolve(ctx.cwd, query);
	} else {
		file = sdk.AgentRegistry.global().get(query)?.sessionFile ?? undefined;
		file ??= selectSession(await sdk.SessionManager.list(ctx.cwd), query);
		file ??= selectSession(await sdk.SessionManager.listAll(), query);
	}
	if (!file) throw new Error(`Session "${query}" was not found. Provide its JSONL path.`);
	const realFile = await fs.realpath(file);
	const info = realFile.endsWith(".jsonl") ? await sdk.readSessionInfo(realFile) : undefined;
	if (!info) {
		throw new Error(`Not a readable OMP JSONL session: ${file}`);
	}
	return { file: realFile, cwd: info.cwd };
}
