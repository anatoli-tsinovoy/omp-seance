import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assertSafeForkDestination } from "../src/source.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; source: string; artifacts: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seance-path-"));
	temporaryDirectories.push(directory);
	const source = path.join(directory, "original.jsonl");
	const artifacts = path.join(directory, "original");
	await Bun.write(source, "source transcript must remain untouched\n");
	await fs.mkdir(artifacts);
	return { directory, source, artifacts };
}

test("rejects self-consultation before a fork can copy its artifact directory into itself", async () => {
	const { source, artifacts } = await fixture();
	await expect(assertSafeForkDestination(source, path.join(artifacts, "SeanceOne.jsonl"))).rejects.toThrow("Self/ancestor");
	expect(await Bun.file(source).text()).toBe("source transcript must remain untouched\n");
	expect(await fs.readdir(artifacts)).toEqual([]);
});

test("rejects an ancestor source even when the new fork would be several directories deeper", async () => {
	const { source, artifacts } = await fixture();
	await expect(assertSafeForkDestination(source, path.join(artifacts, "Child", "Grandchild", "SeanceTwo.jsonl"))).rejects.toThrow("Self/ancestor");
	expect(await fs.readdir(artifacts)).toEqual([]);
});

test("rejects source and destination symlink aliases of the same artifact tree", async () => {
	const { directory, source, artifacts } = await fixture();
	const sourceAlias = path.join(directory, "alias.jsonl");
	const destinationAlias = path.join(directory, "different-parent");
	await fs.symlink(source, sourceAlias);
	await fs.symlink(artifacts, destinationAlias);
	await expect(assertSafeForkDestination(sourceAlias, path.join(destinationAlias, "SeanceThree.jsonl"))).rejects.toThrow("Self/ancestor");
	expect(await fs.readdir(artifacts)).toEqual([]);
});
