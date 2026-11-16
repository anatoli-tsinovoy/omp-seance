import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SeanceSummary } from "../src/runtime.ts";

interface WireMessage { role: string; content?: unknown; }
interface RequestBody { messages: WireMessage[]; tools?: { function: { name: string } }[]; }

// Regressions here make a historical consultant read a same-named file in the wrong project.
test("cross-project consultants read the source workspace and never substitute caller files for a missing source", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seance-cwd-"));
	const caller = path.join(directory, "caller");
	const original = path.join(directory, "original");
	const missing = path.join(directory, "vanished");
	const agentDir = path.join(directory, "agent");
	await fs.mkdir(caller, { recursive: true });
	await fs.mkdir(original);
	await Bun.write(path.join(caller, "evidence.txt"), "CALLER_ONLY_EVIDENCE");
	await Bun.write(path.join(original, "evidence.txt"), "SOURCE_PROJECT_EVIDENCE");
	let available = true;
	let parentStep = 0;
	let childStep = 0;
	let requestId = 0;
	let sourceFile = "";
	let childId = "";
	const failures: string[] = [];
	const expectedFirstReply = () =>
		available ? "FIRST_CURRENT_REPLY=SOURCE_PROJECT_EVIDENCE" : "FIRST_CURRENT_REPLY=SOURCE_UNAVAILABLE_DISCLOSED";
	const expectedSecondReply = () =>
		available ? "SECOND_CURRENT_REPLY=SOURCE_PROJECT_EVIDENCE" : "SECOND_CURRENT_REPLY=SOURCE_UNAVAILABLE_DISCLOSED";
	const lastCurrentReply = (messages: WireMessage[]): string | undefined => {
		const matches = [...JSON.stringify(messages).matchAll(/(?:FIRST|SECOND)_CURRENT_REPLY=(?:SOURCE_PROJECT_EVIDENCE|SOURCE_UNAVAILABLE_DISCLOSED)/g)];
		return matches.at(-1)?.[0];
	};
	const reply = (text: string | undefined, tool?: { name: string; args: object }): Response => {
		const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${++requestId}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: "assistant", content: text };
		const chunk = (fields: object) => `data: ${JSON.stringify({ id: "cwd_smoke", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, ...fields }] })}\n\n`;
		return new Response(chunk({ delta, finish_reason: null }) + chunk({ delta: {}, finish_reason: tool ? "tool_calls" : "stop" }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	};
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0, async fetch(request) {
			if (request.method !== "POST") return Response.json({ data: [{ id: "fixture" }] });
			try {
				const body = await request.json() as RequestBody;
				const tools = (body.tools ?? []).map(tool => tool.function.name);
				const last = body.messages.findLast(message => message.role === "tool");
				const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content) ?? "";
				if (tools.includes("seance")) {
					const step = parentStep++;
					if (step === 0) {
						return reply(undefined, { name: "seance", args: { sourceSession: sourceFile } });
					}
					if (step === 1) {
						const result = JSON.parse(text) as SeanceSummary;
						expect(childStep).toBe(0);
						expect(result.sourceCwd).toBe(available ? original : missing);
						expect(result.sourceCwdAvailable).toBe(available);
						childId = result.id;
						if (available) expect(result.cwd).toBe(original);
						else {
							expect(result.cwd).not.toBe(caller);
							expect(result.cwd).toContain(".unavailable-source-");
							expect(await fs.readdir(result.cwd)).toEqual([]);
						}
						return reply(undefined, {
							name: "write",
							args: { path: `agent://${childId}`, content: "First follow-up: read evidence.txt and report the source project's evidence." },
						});
					}
					if (step === 2) {
						expect(text).toContain(childId);
						return reply(undefined, { name: "wait", args: {} });
					}
					if (step === 3) {
						const visible = JSON.stringify(body.messages);
						expect(visible).toContain(expectedFirstReply());
						expect(lastCurrentReply(body.messages)).toBe(expectedFirstReply());
						expect(visible).not.toContain("HISTORICAL_CONTEXT");
						expect(visible).not.toContain("COPIED_SOURCE_ARTIFACT");
						expect(visible).not.toContain("CALLER_ONLY_EVIDENCE");
						return reply(undefined, {
							name: "write",
							args: { path: `agent://${childId}`, content: "Second follow-up: independently verify the source evidence and give a fresh answer." },
						});
					}
					if (step === 4) {
						expect(text).toContain(childId);
						return reply(undefined, { name: "wait", args: {} });
					}
					if (step === 5) {
						const visible = JSON.stringify(body.messages);
						expect(visible).toContain(expectedSecondReply());
						expect(lastCurrentReply(body.messages)).toBe(expectedSecondReply());
						expect(visible).not.toContain("HISTORICAL_CONTEXT");
						expect(visible).not.toContain("COPIED_SOURCE_ARTIFACT");
						expect(visible).not.toContain("CALLER_ONLY_EVIDENCE");
						return reply("CROSS_PROJECT_PASS");
					}
					throw new Error(`Unexpected parent request ${step}`);
				}

				expect(tools.sort()).toEqual(["glob", "grep", "read", "yield"]);
				expect(JSON.stringify(body.messages)).toContain("HISTORICAL_CONTEXT");
				const step = childStep++;
				if (available) {
					if (step === 0) {
						return reply(undefined, { name: "write", args: { path: path.join(original, "evidence.txt"), content: "CORRUPTED" } });
					}
					if (step === 1) {
						expect(await Bun.file(path.join(original, "evidence.txt")).text()).toBe("SOURCE_PROJECT_EVIDENCE");
						return reply(undefined, { name: "read", args: { path: "artifact://7" } });
					}
					if (step === 2) {
						expect(text).toContain("COPIED_SOURCE_ARTIFACT");
						return reply(undefined, { name: "read", args: { path: "evidence.txt" } });
					}
					if (step === 3) {
						expect(text).toContain("SOURCE_PROJECT_EVIDENCE");
						expect(text).not.toContain("CALLER_ONLY_EVIDENCE");
						return reply(undefined, { name: "yield", args: { data: { answer: expectedFirstReply() } } });
					}
					if (step === 4) return reply(undefined, { name: "read", args: { path: "evidence.txt" } });
					if (step === 5) {
						expect(text).toContain("SOURCE_PROJECT_EVIDENCE");
						expect(text).not.toContain("CALLER_ONLY_EVIDENCE");
						return reply(undefined, { name: "yield", args: { data: { answer: expectedSecondReply() } } });
					}
				} else {
					if (step === 0 || step === 2) return reply(undefined, { name: "read", args: { path: "evidence.txt" } });
					if (step === 1 || step === 3) {
						expect(text).toMatch(/ENOENT|not found|does not exist/i);
						expect(JSON.stringify(body.messages)).toContain("sourceCwdAvailable");
						expect(text).not.toContain("CALLER_ONLY_EVIDENCE");
						return reply(undefined, { name: "yield", args: { data: { answer: step === 1 ? expectedFirstReply() : expectedSecondReply() } } });
					}
				}
				throw new Error(`Unexpected child request ${step}`);
			} catch (error) {
				failures.push(String(error));
				return reply(`PROVIDER_FAILURE: ${String(error)}`);
			}
		}
	});
	try {
		await Bun.write(path.join(agentDir, "models.yml"), `providers:\n  seance-fixture:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: fixture\n        reasoning: false\n        input: [text]\n        contextWindow: 128000\n        maxTokens: 4096\n        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}\n`);
		await Bun.write(path.join(agentDir, "config.yml"), "compaction:\n  enabled: false\nasync:\n  enabled: true\n");
		for (const sourceAvailable of [true, false]) {
			available = sourceAvailable;
			parentStep = 0;
			childStep = 0;
			sourceFile = path.join(directory, sourceAvailable ? "historical.jsonl" : "unavailable.jsonl");
			const timestamp = new Date().toISOString();
			const source = [
				{ type: "session", version: 3, id: crypto.randomUUID(), timestamp, cwd: available ? original : missing },
				{ type: "message", id: "source-message", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "HISTORICAL_CONTEXT" }], timestamp: Date.now() } },
			].map(entry => JSON.stringify(entry)).join("\n") + "\n";
			await Bun.write(sourceFile, source);
			await Bun.write(path.join(sourceFile.slice(0, -6), "7.read.log"), "COPIED_SOURCE_ARTIFACT");
			const subprocess = Bun.spawn([
				process.execPath, path.resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts"),
				"--cwd", caller, "--session-dir", path.join(directory, sourceAvailable ? "sessions-available" : "sessions-missing"),
				"--mode", "json", "--print", "--model", "seance-fixture/fixture",
				"--tools", "seance,write,wait", "--no-lsp", "--no-extensions", "-e", path.resolve(import.meta.dir, "../src/index.ts"),
				"--no-context-files", "--no-rules", "--no-skills", "--thinking", "off", "--offline", "--no-title", "--auto-approve", "--max-time", "20s", "Consult the historical session.",
			], { cwd: caller, env: { PATH: process.env.PATH, HOME: path.join(directory, "home"), PI_CODING_AGENT_DIR: agentDir, NO_COLOR: "1", TERM: "dumb" }, stdout: "pipe", stderr: "pipe" });
			try {
				const [stdout, stderr, exitCode] = await Promise.all([new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited]);
				expect({ exitCode, stderr: exitCode ? stderr : "" }).toEqual({ exitCode: 0, stderr: "" });
				expect(failures).toEqual([]);
				expect(stdout).toContain("CROSS_PROJECT_PASS");
				expect({ parentStep, childStep }).toEqual({ parentStep: 6, childStep: available ? 6 : 4 });
				expect(await Bun.file(sourceFile).text()).toBe(source);
			} finally {
				subprocess.kill();
			}
		}
	} finally {
		server.stop(true);
		await fs.rm(directory, { recursive: true, force: true });
	}
}, 60000);
