import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface WireMessage { role: string; content?: unknown; }
interface RequestBody { messages: WireMessage[]; tools?: { function: { name: string } }[]; }
interface Reply { cwd: string; sourceCwd: string; sourceCwdAvailable: boolean; reply: string; }

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
	const failures: string[] = [];
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
				const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
				if (tools.includes("seance")) {
					if (parentStep++ === 0) return reply(undefined, { name: "seance", args: { action: "spawn", sourceSession: sourceFile, question: "Read evidence.txt relative to the source project." } });
					const result = JSON.parse(text) as Reply;
					expect(result.sourceCwd).toBe(available ? original : missing);
					expect(result.sourceCwdAvailable).toBe(available);
					if (available) expect(result.cwd).toBe(original);
					else {
						expect(result.cwd).not.toBe(caller);
						expect(result.cwd).toContain(".unavailable-source-");
						expect(await fs.readdir(result.cwd)).toEqual([]);
					}
					expect(result.reply).toContain(available ? "SOURCE_READ_VERIFIED" : "SOURCE_UNAVAILABLE_DISCLOSED");
					return reply("CROSS_PROJECT_PASS");
				}
				expect(tools.sort()).toEqual(["glob", "grep", "read"]);
				expect(JSON.stringify(body.messages)).toContain("HISTORICAL_CONTEXT");
				if (childStep++ === 0) return reply(undefined, { name: "read", args: { path: "evidence.txt" } });
				if (available) expect(text).toContain("SOURCE_PROJECT_EVIDENCE");
				else {
					expect(text).toMatch(/ENOENT|not found|does not exist/i);
					expect(JSON.stringify(body.messages)).toContain("sourceCwdAvailable");
				}
				expect(text).not.toContain("CALLER_ONLY_EVIDENCE");
				return reply(available ? "SOURCE_READ_VERIFIED" : "SOURCE_UNAVAILABLE_DISCLOSED");
			} catch (error) {
				failures.push(String(error));
				return reply(`PROVIDER_FAILURE: ${String(error)}`);
			}
		}
	});
	try {
		await Bun.write(path.join(agentDir, "models.yml"), `providers:\n  seance-fixture:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: fixture\n        reasoning: false\n        input: [text]\n        contextWindow: 128000\n        maxTokens: 4096\n        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}\n`);
		await Bun.write(path.join(agentDir, "config.yml"), "compaction:\n  enabled: false\n");
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
			const subprocess = Bun.spawn([
				process.execPath, path.resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts"),
				"--cwd", caller, "--mode", "json", "--print", "--model", "seance-fixture/fixture",
				"--tools", "seance", "--no-lsp", "--no-extensions", "-e", path.resolve(import.meta.dir, "../src/index.ts"),
				"--no-context-files", "--no-rules", "--no-skills", "--thinking", "off", "--offline", "--no-title", "--auto-approve", "--max-time", "20s", "Consult the historical session.",
			], { cwd: caller, env: { PATH: process.env.PATH, HOME: path.join(directory, "home"), PI_CODING_AGENT_DIR: agentDir, NO_COLOR: "1", TERM: "dumb" }, stdout: "pipe", stderr: "pipe" });
			try {
				const [stdout, stderr, exitCode] = await Promise.all([new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited]);
				expect({ exitCode, stderr: exitCode ? stderr : "" }).toEqual({ exitCode: 0, stderr: "" });
				expect(failures).toEqual([]);
				expect(stdout).toContain("CROSS_PROJECT_PASS");
				expect({ parentStep, childStep }).toEqual({ parentStep: 2, childStep: 2 });
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
