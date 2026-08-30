import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: ["**/.earendil/**"],
		include: ["test/wrap-ansi.test.ts"],
	},
});
