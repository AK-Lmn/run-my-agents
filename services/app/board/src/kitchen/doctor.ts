import { JsonStore } from "./store";

export type Incident = { at: number; n: number; stage: string; cls: string; evidence: string[] };

const store = new JsonStore<Incident>("incidents.json");
const droppedStore = new JsonStore<string>("doctor-dropped.json");

const KEEP_MS = 30 * 86_400_000;
export const FIX_TITLE = "Fix a bug in the run-my-agents Kitchen: ";

export function readIncidents(now = Date.now()): Incident[] {
	return store.read().filter((x) => now - x.at <= KEEP_MS);
}

export function logIncident(n: number, stage: string, evidence: string[], now = Date.now()): void {
	const incidents = readIncidents(now);
	incidents.push({
		at: now,
		n,
		stage,
		cls: classOf(evidence),
		evidence: evidence.slice(-6).map((l) => String(l).slice(0, 300)),
	});
	store.write(incidents);
}

export function classOf(lines: string[]): string {
	const text = lines.join("\n");
	if (/worktree gone|no worktree|cannot change to/i.test(text)) return "missing worktree";
	if (/git [^\n]*tim(ed )?out|timed out[^\n]*git/i.test(text)) return "git timeout";
	if (/lint/i.test(text) && /FAIL/.test(text)) return "test FAIL on lint";
	if (/could not run this turn/i.test(text)) return "crashed turn";
	if (/Missed: no progress/i.test(text)) return "silent agent";
	return "other";
}

export function readDropped(): string[] {
	return droppedStore.read();
}

export function dropClass(cls: string): void {
	const dropped = readDropped();
	if (!dropped.includes(cls)) {
		dropped.push(cls);
		droppedStore.write(dropped);
	}
}

const LIKELY_FILE: Record<string, string> = {
	"missing worktree": "services/app/board/src/kitchen/routes.ts",
	"git timeout": "services/app/board/src/kitchen/routes.ts",
	"test FAIL on lint": "services/app/board/src/kitchen/routes.ts",
	"crashed turn": "services/app/board/src/kitchen/routes.ts",
	"silent agent": "services/app/board/src/kitchen/routes.ts",
	other: "services/app/board/src/kitchen/routes.ts",
};

const TEST_IDEA: Record<string, string> = {
	"missing worktree": "add a test in services/app/board/tests that reproduces the class and asserts the board recovers by itself.",
	"git timeout": "add a test in services/app/board/tests that reproduces the class and asserts the board recovers by itself.",
	"test FAIL on lint": "add a test in services/app/board/tests that reproduces the class and asserts the board recovers by itself.",
	"crashed turn": "add a test in services/app/board/tests that reproduces the class and asserts the board recovers by itself.",
	"silent agent": "add a test in services/app/board/tests that reproduces the class and asserts the board recovers by itself.",
	other: "add a test in services/app/board/tests that reproduces the class and asserts the board recovers by itself.",
};

export function draftText(cls: string, hits: Incident[], orders: number[]): string {
	const why = `${cls} hit ${orders.map((n) => `#${n}`).join(" and ")}`;
	const lines = [
		`Fix a bug in the run-my-agents Kitchen: ${cls}`,
		"",
		`Evidence (${why}):`,
		...hits.slice(-4).flatMap((h) => h.evidence.map((e) => `- #${h.n} ${h.stage}: ${e}`)),
		"",
		`Likely file: ${LIKELY_FILE[cls] || "services/app/board/src/kitchen/routes.ts"}`,
		"",
		`Test idea: ${TEST_IDEA[cls] || "add a test in services/app/board/tests that reproduces the class and asserts the board recovers by itself."}`,
	];
	return lines.join("\n").replace(/flisk[\w.-]*/gi, "the platform");
}

export function draftFor(
	incidents: Incident[],
	dropped: string[],
	draftOpen: boolean,
): { cls: string; orders: number[]; title: string; what: string; why: string } | undefined {
	if (draftOpen) return undefined;
	for (const cls of [...new Set(incidents.map((i) => i.cls))]) {
		if (cls === "other" || dropped.includes(cls)) continue;
		const hits = incidents.filter((i) => i.cls === cls);
		const orders = [...new Set(hits.map((i) => i.n))];
		if (orders.length < 2) continue;
		const why = `${cls} hit ${orders.map((n) => `#${n}`).join(" and ")}`;
		return {
			cls,
			orders,
			title: `${FIX_TITLE}${cls}`.slice(0, 200),
			what: draftText(cls, hits, orders),
			why,
		};
	}
	return undefined;
}
