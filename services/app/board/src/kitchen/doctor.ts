import { existsSync } from "node:fs";
import { JsonStore } from "./store";
import { addTask, readTasks, updateTask, type Task } from "./pipeline";

export type Incident = { id: string; n: number; stage: string; cls: string; at: number; evidence: string[] };
export const KEEP_MS = 30 * 86_400_000;
export const DRAFT_PREFIX = "Fix a bug in the run-my-agents Kitchen: ";

export const draftTitle = (cls: string, ns: number[]) =>
	`${DRAFT_PREFIX}${cls} stopped orders ${ns.map((n) => `#${n}`).join(" and ")}`;

export const classOfDraft = (title: string) =>
	/^Fix a bug in the run-my-agents Kitchen: (.+?) stopped orders /.exec(title)?.[1];

export function classOf(line: string): string {
	const lower = line.toLowerCase();
	if (/worktree gone|no worktree|cannot change to/.test(lower)) return "missing worktree";
	if (/git .*(timed out|timeout)|timeout.*git/.test(lower)) return "git timeout";
	if (/could not run this turn|crash/.test(lower)) return "crashed turn";
	if (/lint/.test(lower)) return "test FAIL on lint";
	if (/no answer in|no changes made in the worktree|silent/.test(lower)) return "silent agent";
	return "stuck order";
}

const incidentStore = new JsonStore<Incident>("incidents.json");

export function readIncidents(now = Date.now()): Incident[] {
	return incidentStore.read().filter((i) => now - i.at <= KEEP_MS);
}

export function logIncident(
	x: { n: number; stage: string; evidence: string[]; cls?: string },
	now = Date.now()
): Incident {
	const cls = x.cls ?? classOf(x.evidence.join(" "));
	const id = `${now}-${x.n}-${cls}`;
	const incident: Incident = { id, n: x.n, stage: x.stage, cls, at: now, evidence: x.evidence };

	incidentStore.update((all) => {
		all.push(incident);
		return all.filter((i) => now - i.at <= KEEP_MS);
	});

	return incident;
}

export function boardPark(id: string, cls: string, path?: string): void {
	updateTask(id, {
		parked: true,
		parkedBy: "board",
		parkCause: { cls, path },
		assignee: "",
		sentAt: 0,
	});
}

export function unparkFixed(exists: (p: string) => boolean = (p) => existsSync(p)): string[] {
	const unpacked: string[] = [];
	const tasks = readTasks();
	for (const t of tasks) {
		if (t.parked && t.parkedBy === "board" && t.parkCause?.path && exists(t.parkCause.path)) {
			updateTask(t.id, { parked: false, parkedBy: undefined, parkCause: undefined });
			unpacked.push(`#${t.n} un-parked: ${t.parkCause.cls} is gone`);
		}
	}
	return unpacked;
}

export const LIKELY_FILE: Record<string, string> = {
	"missing worktree": "services/app/board/src/kitchen/routes.ts (orderWorktree)",
	"git timeout": "services/app/board/src/kitchen/routes.ts",
	"crashed turn": "services/app/board/src/kitchen/routes.ts",
	"test FAIL on lint": "services/app/board/src/kitchen/routes.ts",
	"silent agent": "services/app/board/src/kitchen/routes.ts",
	"stuck order": "services/app/board/src/kitchen/routes.ts",
};

export function draftBody(cls: string, hits: Incident[]): string {
	const lines: string[] = [];
	lines.push(`Stopped orders: ${hits.map((h) => `#${h.n}`).join(", ")}.`);
	lines.push("");
	lines.push("Evidence:");
	for (const h of hits) {
		lines.push(`- #${h.n} at ${h.stage}: ${h.evidence[0] ?? ""}`);
	}
	lines.push("");
	lines.push(`Likely file: ${LIKELY_FILE[cls] ?? "services/app/board/src/kitchen/routes.ts"}`);
	lines.push("");
	lines.push("Test idea: services/app/board/tests/doctor.test.ts");
	return lines.join("\n");
}

const droppedStore = new JsonStore<{ cls: string; at: number }>("doctor-dropped.json");

export function dropDraftClass(cls: string): void {
	droppedStore.update((all) => {
		if (!all.find((x) => x.cls === cls)) {
			all.push({ cls, at: Date.now() });
		}
		return all;
	});
}

export function droppedClasses(): string[] {
	return droppedStore.read().map((x) => x.cls);
}

export function proposeDraft(cwd: string, now = Date.now()): string[] {
	const tasks = readTasks();

	// Check if any open draft exists
	if (tasks.some((t) => t.title.startsWith(DRAFT_PREFIX) && !t.approved && t.stage !== "done")) {
		return [];
	}

	const incidents = readIncidents(now);
	const dropped = droppedClasses();

	// Orders already named by an earlier draft (open, done or failed) are covered: the same evidence must not
	// draft the same class again once that fix has run.
	const covered = new Set<string>();
	for (const t of tasks) {
		const cls = classOfDraft(t.title);
		if (!cls) continue;
		for (const m of t.title.matchAll(/#(\d+)/g)) covered.add(`${cls}#${m[1]}`);
	}

	// Group incidents by class
	const byClass = new Map<string, Incident[]>();
	for (const incident of incidents) {
		if (!dropped.includes(incident.cls) && !covered.has(`${incident.cls}#${incident.n}`)) {
			if (!byClass.has(incident.cls)) byClass.set(incident.cls, []);
			byClass.get(incident.cls)!.push(incident);
		}
	}

	// Find first class with 2+ orders (by oldest incident)
	let bestClass: string | undefined;
	let bestIncidents: Incident[] | undefined;
	let bestOldest = Infinity;

	for (const [cls, incs] of byClass) {
		const ns = new Set(incs.map((i) => i.n));
		if (ns.size >= 2) {
			const oldest = Math.min(...incs.map((i) => i.at));
			if (oldest < bestOldest) {
				bestClass = cls;
				bestIncidents = incs;
				bestOldest = oldest;
			}
		}
	}

	if (!bestClass || !bestIncidents) return [];

	const ns = Array.from(new Set(bestIncidents.map((i) => i.n))).sort((a, b) => a - b);
	const draft = addTask({
		title: draftTitle(bestClass, ns),
		cwd,
		priority: "P2",
		kind: "task",
		route: "Bug",
	});

	updateTask(draft.id, { notes: { inbox: draftBody(bestClass, bestIncidents) } });

	return [`#${draft.n} drafted a fix for ${bestClass}`];
}
