import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index";
import { addTask, readTasks, removeTask, type Task, updateTask } from "../src/kitchen/pipeline";
import { dataDir, REAL_DATA_DIR } from "../src/prefs";
import { dropLostWorktrees } from "../src/kitchen/routes";
import { FIX_TITLE, logIncident, readDropped, readIncidents } from "../src/kitchen/doctor";

let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rma-doctor-"));
	process.env.RUN_MY_AGENTS_DIR = dir;
	process.env.RUN_MY_AGENTS_SKILLS_DIR = mkdtempSync(join(tmpdir(), "rma-doctor-skills-"));
});

function setup(prState?: (cwd: string, url: string) => string) {
	const app = createApp(() => [], async () => {}, {
		start: async () => {},
		fetch: (async () => new Response("---\nname: x\n---\n")) as unknown as typeof fetch,
		...(prState ? { prState } : {}),
	});
	const post = async (path: string, body: object) => {
		const r = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: r.status, body: (await r.json()) as Record<string, never> };
	};
	const get = async (path: string) => (await (await app.request(path)).json()) as Record<string, never>;
	return { post, get };
}

const task = (i: number, o: object = {}) => ({
	id: `t${i}`,
	n: i + 1,
	title: "fix it",
	cwd: "/work/app",
	priority: "P1",
	stage: "build",
	assignee: "",
	sentAt: 0,
	approved: true,
	skills: [],
	route: "Code",
	kind: "task",
	rounds: 0,
	stuck: false,
	created: i + 1,
	updated: 1,
	...o,
});

const put = (ts: object[]) => writeFileSync(join(dir, "tasks.json"), JSON.stringify(ts));
const read = () => JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as Task[];
const one = (n: number) => read().find((t) => t.n === n) as Task;
const settings = (o: object = {}) =>
	writeFileSync(join(dir, "kitchen.json"), JSON.stringify([{ auto: true, idleMinutes: 10, wipOn: true, wipLimit: 3, wipSince: 1, ...o }]));

const crew = async (post: ReturnType<typeof setup>["post"]) => {
	await post("/api/containers", { name: "Builders", role: "Code", stages: ["build", "test"], replicas: 10, cwd: "/work/app" });
	await post("/api/containers/reconcile", {});
};

describe("PART 1: test isolation", () => {
	it("a test run with no setup writes to the temp folder and never to the real one", () => {
		addTask({ title: "x" });
		expect(existsSync(join(process.env.RUN_MY_AGENTS_DIR!, "tasks.json"))).toBe(true);
		expect(process.env.RUN_MY_AGENTS_DIR!.startsWith(tmpdir())).toBe(true);
	});

	it("dataDir() throws for the real folder under test", () => {
		const realDir = join(homedir(), ".run-my-agents");
		const old = process.env.RUN_MY_AGENTS_DIR;
		try {
			process.env.RUN_MY_AGENTS_DIR = realDir;
			expect(() => dataDir()).toThrow(/must not use the real/);
		} finally {
			process.env.RUN_MY_AGENTS_DIR = old;
		}
	});
});

describe("PART 2: doctor incidents and auto-recovery", () => {
	it("a stuck order logs an incident", async () => {
		const { post } = setup();
		settings();
		put([task(0, { stuck: true, stage: "test", failures: ["test: FAIL: lint errors"] })]);
		await post("/api/kitchen", { auto: true });

		const incidents = readIncidents();
		expect(incidents).toHaveLength(1);
		expect(incidents[0]).toMatchObject({
			n: 1,
			stage: "test",
			cls: "test FAIL on lint",
		});
	});

	it("a missing worktree is recreated once and then stuck", () => {
		put([task(0, { worktree: "/gone/wt", stage: "build", assignee: "agent1", sentAt: 1 })]);
		dropLostWorktrees();
		expect(one(1)).toMatchObject({ stuck: false, wtRetried: true });

		// Set it to another missing path (simulating retry didn't help)
		updateTask(one(1).id, { worktree: "/gone/wt2" });
		dropLostWorktrees();
		expect(one(1)).toMatchObject({ stuck: true });
	});

	it("a person-parked order is not un-parked", async () => {
		const { post } = setup();
		settings();
		const t1 = addTask({ title: "x", priority: "P1" });
		const t2 = addTask({ title: "y", priority: "P1" });
		updateTask(t1.id, { parked: true, parkedBy: "hand" });
		updateTask(t2.id, { parked: true, parkedBy: "system", parkCause: "git timeout" });
		// Do NOT log the git timeout incident, so t2 can be un-parked

		await post("/api/kitchen", { auto: true });

		expect(read().find((t) => t.n === 1)?.parked).toBe(true);
		expect(read().find((t) => t.n === 2)?.parked).toBe(false);
	});

	it("two orders with one class make one draft", async () => {
		const { post } = setup();
		settings();
		await crew(post);

		// Create two incidents with the same class
		logIncident(1, "build", ["worktree gone: /a"]);
		logIncident(2, "build", ["worktree gone: /b"]);

		// Run auto twice to trigger proposeFix
		await post("/api/kitchen", { auto: true });
		await post("/api/kitchen", { auto: true });

		const drafts = read().filter((t) => t.title.startsWith(FIX_TITLE));
		expect(drafts).toHaveLength(1);
		expect(drafts[0]).toMatchObject({
			approved: false,
			title: expect.stringContaining("missing worktree"),
		});
		expect(drafts[0].zachman?.what).toContain("Evidence");
	});

	it("a second class waits while a draft is open", async () => {
		const { post } = setup();
		settings();
		await crew(post);

		// Create incidents for one class
		logIncident(1, "build", ["worktree gone: /a"]);
		logIncident(2, "build", ["worktree gone: /b"]);
		await post("/api/kitchen", { auto: true });

		// Create incidents for another class
		logIncident(3, "test", ["could not run this turn: timeout"]);
		logIncident(4, "test", ["could not run this turn: timeout"]);

		// Run auto again: should not create a second draft while the first is open
		await post("/api/kitchen", { auto: true });

		const drafts = read().filter((t) => t.title.startsWith(FIX_TITLE));
		expect(drafts).toHaveLength(1);
	});

	it("a dropped draft is not proposed again", async () => {
		const { post } = setup();
		settings();
		await crew(post);

		// Create incidents
		logIncident(1, "build", ["worktree gone: /a"]);
		logIncident(2, "build", ["worktree gone: /b"]);
		await post("/api/kitchen", { auto: true });

		const draft = read().find((t) => t.title.startsWith(FIX_TITLE));
		expect(draft).toBeDefined();

		// Drop the draft
		await post("/api/tasks/drop", { id: draft!.id });

		// Run auto again: should not create a new draft
		await post("/api/kitchen", { auto: true });

		const drafts = read().filter((t) => t.title.startsWith(FIX_TITLE));
		expect(drafts).toHaveLength(0);

		// Verify the class was dropped
		expect(readDropped()).toContain("missing worktree");
	});

	it("the draft text has no product name", async () => {
		// Use simple crashed turn incidents to ensure they match a known class
		logIncident(3, "build", ["could not run this turn: Flisk agent timeout"]);
		logIncident(4, "build", ["could not run this turn: flisk integration failed"]);

		const { post, get } = setup();
		settings();
		await crew(post);

		await post("/api/kitchen", { auto: true });
		await post("/api/kitchen", { auto: true });

		// Check via the API instead of direct file read
		const data = await get("/api/tasks");
		const draft = (data.tasks as Array<Task & { why?: string }>).find((t) => t.title?.startsWith?.(FIX_TITLE));
		expect(draft).toBeDefined();

		const text = (draft!.title || "") + (draft!.zachman?.what || "") + (draft!.why || "");
		expect(/flisk/i.test(text)).toBe(false);
	});
});
