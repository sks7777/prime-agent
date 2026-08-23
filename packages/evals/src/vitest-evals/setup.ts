// @ts-nocheck
import { afterEach } from "vitest";
import type {} from "vitest-evals";
import { recordEvalSessionArtifact } from "./artifacts.js";

afterEach(async ({ task }) => {
	const run = task.meta.harness?.run;
	if (run) await recordEvalSessionArtifact(task, run);
});
