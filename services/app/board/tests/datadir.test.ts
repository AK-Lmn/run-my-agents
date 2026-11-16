import { describe, it, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dataDir } from "../src/prefs";
import { addTask } from "../src/kitchen/pipeline";

describe("dataDir safety", () => {
	it("no setup still writes to a temp folder", () => {
		const current = dataDir();
		expect(current.startsWith(tmpdir())).toBe(true);
		expect(current).not.toBe(join(homedir(), ".run-my-agents"));
	});

	it("dataDir throws for the live folder under test", () => {
		const saved = process.env.RUN_MY_AGENTS_DIR;
		try {
			process.env.RUN_MY_AGENTS_DIR = join(homedir(), ".run-my-agents");
			expect(() => dataDir()).toThrow(/live board folder/);

			delete process.env.RUN_MY_AGENTS_DIR;
			expect(() => dataDir()).toThrow(/live board folder/);
		} finally {
			if (saved) process.env.RUN_MY_AGENTS_DIR = saved;
			else delete process.env.RUN_MY_AGENTS_DIR;
		}
	});

	it("addTask never touches the real tasks.json", () => {
		const realPath = join(homedir(), ".run-my-agents", "tasks.json");
		let realHash: string | null = null;

		if (existsSync(realPath)) {
			realHash = createHash("sha1").update(readFileSync(realPath)).digest("hex");
		}

		addTask({ title: "doctor-probe", cwd: "/tmp" });

		if (realHash !== null && existsSync(realPath)) {
			const newHash = createHash("sha1").update(readFileSync(realPath)).digest("hex");
			expect(newHash).toBe(realHash);
		}
	});
});
