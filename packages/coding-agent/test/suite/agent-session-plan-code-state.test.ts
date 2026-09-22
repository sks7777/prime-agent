import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

type AppendEntryApi = { appendEntry: (customType: string, data?: unknown) => void };

describe("plan-code mode state", () => {
	it("emits plan_code_mode when the extension appends its mode entry", async () => {
		const extension = (pi: AppendEntryApi & { on: (event: string, handler: () => void) => void }) => {
			pi.on("session_start", () => {
				pi.appendEntry("plan-code-mode", { mode: "plan", todos: [], executing: false });
				pi.appendEntry("plan-code-mode", {
					mode: "code",
					executing: true,
					todos: [{ step: 1, text: "First", completed: false }],
				});
				pi.appendEntry("plan-code-mode", { mode: undefined });
			});
		};
		const harness = await createHarness({
			extensionFactories: [extension as never],
		});
		harnesses.push(harness);
		// session_start (and the appendEntry runtime bindings) activate on bind.
		await harness.session.bindExtensions({});

		const events = harness.eventsOfType("plan_code_mode");
		expect(events).toHaveLength(3);
		expect(events[0]?.planCode).toEqual({ mode: "plan", todos: [], executing: false });
		expect(events[1]?.planCode).toEqual({
			mode: "code",
			executing: true,
			todos: [{ step: 1, text: "First", completed: false }],
		});
		// Exit publishes an empty payload so consumers clear the mode state.
		expect(events[2]?.planCode).toEqual({});
		expect(harness.session.planCodeState).toEqual({});
	});

	it("ignores malformed plan-code entries and unrelated custom entries", async () => {
		const extension = (pi: AppendEntryApi & { on: (event: string, handler: () => void) => void }) => {
			pi.on("session_start", () => {
				pi.appendEntry("other-entry", { mode: "plan" });
				pi.appendEntry("plan-code-mode", { mode: "bogus" });
				pi.appendEntry("plan-code-mode", { executing: "yes" });
			});
		};
		const harness = await createHarness({
			extensionFactories: [extension as never],
		});
		harnesses.push(harness);
		// session_start (and the appendEntry runtime bindings) activate on bind.
		await harness.session.bindExtensions({});

		expect(harness.eventsOfType("plan_code_mode")).toHaveLength(0);
		expect(harness.session.planCodeState).toBeUndefined();
	});

	it("exposes the latest mode state via session.planCodeState", async () => {
		const extension = (pi: AppendEntryApi & { on: (event: string, handler: () => void) => void }) => {
			pi.on("session_start", () => {
				pi.appendEntry("plan-code-mode", {
					mode: "plan",
					executing: true,
					todos: [{ step: 1, text: "Only step", completed: true }],
				});
				pi.appendEntry("plan-code-mode", { mode: "code", executing: false });
			});
		};
		const harness = await createHarness({
			extensionFactories: [extension as never],
		});
		harnesses.push(harness);
		// session_start (and the appendEntry runtime bindings) activate on bind.
		await harness.session.bindExtensions({});

		expect(harness.session.planCodeState).toEqual({ mode: "code", executing: false });
	});
});
