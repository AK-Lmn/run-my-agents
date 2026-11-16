import { describe, it, expect, beforeEach } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, existsSync } from "node:fs";
import {
	classOf,
	readIncidents,
	logIncident,
	boardPark,
	unparkFixed,
	proposeDraft,
	classOfDraft,
	DRAFT_PREFIX,
	droppedClasses,
	dropDraftClass,
} from "../src/kitchen/doctor";
import { addTask, readTasks, updateTask } from "../src/kitchen/pipeline";
import { dropLostWorktrees } from "../src/kitchen/routes";

describe("doctor", () => {
	beforeEach(() => {
		process.env.RUN_MY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "rma-doctor-"));
	});

	it("classOf names the class", () => {
		expect(classOf("board: worktree gone: /x")).toBe("missing worktree");
		expect(classOf("test: FAIL: new lint errors")).toBe("test FAIL on lint");
	});

	it("an incident older than 30 days is dropped", () => {
		const now = Date.now();
		logIncident({ n: 1, stage: "test", evidence: ["old"] }, now - 31 * 86_400_000);
		expect(readIncidents(now)).toHaveLength(0);
	});

	it("a stuck order logs an incident", async () => {
		const task = addTask({ title: "test order", cwd: "/tmp", kind: "task" });
		updateTask(task.id, { stage: "test", stuck: true, failures: ["test: FAIL: new lint errors"] });
		logIncident({ n: task.n, stage: "test", evidence: ["test: FAIL: new lint errors"] });
		const incidents = readIncidents();
		const matching = incidents.filter((i) => i.n === task.n && i.cls === "test FAIL on lint");
		expect(matching.length).toBeGreaterThan(0);
	});

	it("a missing worktree is recreated once and then stuck", () => {
		const task = addTask({ title: "wt test", cwd: "/tmp", kind: "task" });
		updateTask(task.id, { stage: "build", worktree: "/nonexistent/.kitchen/order-2" });
		dropLostWorktrees();
		let t = readTasks().find((x) => x.id === task.id);
		expect(t?.wtRetry).toBe(1);
		expect(t?.stuck).toBe(false);
		updateTask(task.id, { worktree: "/nonexistent/.kitchen/order-2" });
		dropLostWorktrees();
		t = readTasks().find((x) => x.id === task.id);
		expect(t?.stuck).toBe(true);
	});

	it("a person-parked order is not un-parked", () => {
		const task = addTask({ title: "hand park", cwd: "/tmp", kind: "task" });
		const tmpDir = mkdtempSync(join(tmpdir(), "rma-park-"));
		updateTask(task.id, {
			parked: true,
			parkedBy: "hand",
			parkCause: { cls: "test", path: tmpDir },
		});
		unparkFixed();
		const t = readTasks().find((x) => x.id === task.id);
		expect(t?.parked).toBe(true);
	});

	it("a board-parked order is un-parked when its folder is back", () => {
		const task = addTask({ title: "board park", cwd: "/tmp", kind: "task" });
		const tmpDir = mkdtempSync(join(tmpdir(), "rma-unpark-"));
		updateTask(task.id, {
			parked: true,
			parkedBy: "board",
			parkCause: { cls: "x", path: tmpDir },
		});
		const result = unparkFixed();
		const t = readTasks().find((x) => x.id === task.id);
		expect(t?.parked).toBe(false);
		expect(t?.parkedBy).toBeUndefined();
		expect(result.some((r) => r.includes("un-parked"))).toBe(true);
	});

	it("two orders with one class make one draft", () => {
		const now = Date.now();
		logIncident({ n: 5, stage: "test", cls: "lint fail", evidence: ["lint error 1"] }, now);
		logIncident({ n: 6, stage: "test", cls: "lint fail", evidence: ["lint error 2"] }, now);
		const result = proposeDraft("/tmp", now);
		expect(result.length).toBeGreaterThan(0);
		const draft = readTasks().find((t) => t.title.startsWith(DRAFT_PREFIX));
		expect(draft).toBeDefined();
		expect(draft?.title).toContain("lint fail");
	});

	it("a second class waits while a draft is open", () => {
		const now = Date.now();
		addTask({
			title: DRAFT_PREFIX + "class1 stopped orders #1 and #2",
			cwd: "/tmp",
			kind: "task",
		});
		logIncident({ n: 7, stage: "test", cls: "class2", evidence: ["error"] }, now);
		logIncident({ n: 8, stage: "test", cls: "class2", evidence: ["error"] }, now);
		const result = proposeDraft("/tmp", now);
		expect(result).toHaveLength(0);
	});

	it("a finished draft does not draft the same evidence again", () => {
		const now = Date.now();
		logIncident({ n: 20, stage: "test", cls: "git timeout", evidence: ["e"] }, now);
		logIncident({ n: 21, stage: "test", cls: "git timeout", evidence: ["e"] }, now);
		expect(proposeDraft("/tmp", now)).toHaveLength(1);
		const draft = readTasks().find((t) => t.title.startsWith(DRAFT_PREFIX))!;
		updateTask(draft.id, { stage: "done" });
		expect(proposeDraft("/tmp", now)).toHaveLength(0);
		// two new orders with the same class are fresh evidence
		logIncident({ n: 22, stage: "test", cls: "git timeout", evidence: ["e"] }, now);
		logIncident({ n: 23, stage: "test", cls: "git timeout", evidence: ["e"] }, now);
		expect(proposeDraft("/tmp", now)).toHaveLength(1);
	});

	it("a dropped draft is not proposed again", () => {
		const now = Date.now();
		dropDraftClass("dropped-class");
		logIncident({ n: 9, stage: "test", cls: "dropped-class", evidence: ["error"] }, now);
		logIncident({ n: 10, stage: "test", cls: "dropped-class", evidence: ["error"] }, now);
		const result = proposeDraft("/tmp", now);
		expect(result).toHaveLength(0);
		expect(droppedClasses()).toContain("dropped-class");
	});

	it("the draft text has no product name", () => {
		const now = Date.now();
		logIncident({ n: 11, stage: "test", cls: "test fail", evidence: ["error 1"] }, now);
		logIncident({ n: 12, stage: "test", cls: "test fail", evidence: ["error 2"] }, now);
		proposeDraft("/tmp", now);
		const draft = readTasks().find((t) => t.title.startsWith(DRAFT_PREFIX));
		expect(draft?.notes?.inbox).toBeDefined();
		const body = draft?.notes?.inbox ?? "";
		expect(body).not.toMatch(/run-my-agents|flisk/i);
	});
});
