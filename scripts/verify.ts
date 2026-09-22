#!/usr/bin/env node
/**
 * `verify` for a project: the one command the milestones are measured by.
 *
 * It compiles, generates every target in both idiom modes, regenerates and diffs for determinism,
 * runs each target's linters, and then runs the project's own conformance runner. A milestone is
 * not complete while this is red.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { formattersOf } from "../src/backend/format.ts";

const ENGINE = resolve(import.meta.dirname, "..");
const project = resolve(process.argv[2] ?? ".");

type Step = { name: string; run: () => { ok: boolean; output?: string } };

function shell(command: string, args: readonly string[], cwd: string): { ok: boolean; output?: string } {
	// A missing working directory and a missing command both surface as ENOENT from `spawnSync`,
	// and reporting the second when it was the first is a lie that reads as reassurance: a project
	// that does not generate a target has no output directory for that target, and saying its
	// compiler "is not installed" hides the fact that the step ran against nothing. Checked first,
	// so the message names what is actually absent.
	if (!existsSync(cwd)) return { ok: true, output: `skipped: ${cwd} does not exist` };
	const result = spawnSync(command, [...args], { cwd, encoding: "utf8" });
	if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
		return { ok: true, output: `skipped: ${command} is not installed` };
	}
	return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

/**
 * The targets this project actually generates, which is what decides how many of the per-target
 * steps below are real. The engine is generic — a project names its own targets, and a project
 * that does not build Rust should not be told about Rust's toolchain at all.
 */
function configuredTargets(): readonly string[] {
	try {
		const config = JSON.parse(readFileSync(join(project, "engine.config.json"), "utf8")) as { targets?: string[] };
		return config.targets ?? [];
	} catch {
		return [];
	}
}

const TARGETS = configuredTargets();

/** Wraps a per-target step so a project that does not build that target says so, once, plainly. */
function forTarget(target: string, run: () => { ok: boolean; output?: string }): () => { ok: boolean; output?: string } {
	return () => (TARGETS.includes(target) ? run() : { ok: true, output: `skipped: ${target} is not a target of this project` });
}

function filesOf(root: string): Map<string, string> {
	const files = new Map<string, string>();
	if (!existsSync(root)) return files;
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory)) {
			const full = join(directory, entry);
			if (statSync(full).isDirectory()) walk(full);
			else files.set(relative(root, full), readFileSync(full, "utf8"));
		}
	};
	walk(root);
	return files;
}

/** Every generated TypeScript file except the differential driver, which imports node globals. */
function generatedTypeScript(root: string): string[] {
	const files: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory)) {
			const full = join(directory, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (entry.endsWith(".ts") && entry !== "_driver.ts") files.push(relative(root, full));
		}
	};
	walk(root);
	return files;
}

const steps: Step[] = [
	{
		// The generated output is committed, so a missing formatter is not a missing nicety: it
		// produces different bytes for the same program, and every later step would pass while the
		// checkout drifts from what is in the repository.
		name: "formatters",
		run: () => {
			const missing = ["typescript", "python", "go", "rust"].flatMap((target) =>
				formattersOf(target)
					.filter((formatter) => !formatter.installed)
					.map((formatter) => `${target}: ${formatter.name}`),
			);
			return missing.length === 0
				? { ok: true }
				: { ok: false, output: `not installed, so the output would differ from the committed one:\n${missing.join("\n")}` };
		},
	},
	{
		name: "engine tests",
		run: () =>
			shell(
				process.execPath,
				[
					"--test",
					"--test-reporter=dot",
					...readdirSync(join(ENGINE, "tests"))
						.filter((entry) => entry.endsWith(".spec.ts"))
						.map((entry) => join("tests", entry)),
				],
				ENGINE,
			),
	},
	{
		name: "engine typecheck",
		run: () => shell(join(ENGINE, "node_modules", ".bin", "tsc"), ["--noEmit", "-p", "tsconfig.json"], ENGINE),
	},
	{
		// A small, fixed seed budget on every verification: no code generation, so it is cheap
		// enough to run here rather than only on demand. See docs/fuzzing.md for the full story,
		// and `node scripts/fuzz.ts full` for the slower, deliberately-run four-target comparison.
		name: "fuzz (fast, checker vs. interpreter)",
		run: () => shell(process.execPath, [join(ENGINE, "scripts", "fuzz.ts"), "fast", "--seed", "20260921", "--count", "1000"], ENGINE),
	},
	{
		name: "check",
		run: () => shell(process.execPath, [join(ENGINE, "src", "cli.ts"), "check", "--project", project], project),
	},
	{
		name: "generate (idiomatic)",
		run: () => shell(process.execPath, [join(ENGINE, "src", "cli.ts"), "build", "--project", project], project),
	},
	{
		name: "generate (--no-idioms)",
		run: () =>
			shell(process.execPath, [join(ENGINE, "src", "cli.ts"), "build", "--project", project, "--no-idioms"], project),
	},
	{
		name: "determinism",
		run: () => {
			const out = join(project, "out");
			const copy = join(project, ".out-previous");
			rmSync(copy, { recursive: true, force: true });
			cpSync(out, copy, { recursive: true });
			const regenerated = shell(process.execPath, [join(ENGINE, "src", "cli.ts"), "build", "--project", project], project);
			if (!regenerated.ok) return regenerated;
			const before = filesOf(copy);
			const after = filesOf(out);
			rmSync(copy, { recursive: true, force: true });
			for (const [path, text] of after) {
				// Fixtures are written by the conformance runner, and formatter caches by the
				// formatters; neither is compiler output.
				if (path.endsWith("fixtures.json") || path.includes("cache")) continue;
				if (before.get(path) !== text) return { ok: false, output: `${path} differs between two runs` };
			}
			return { ok: true };
		},
	},
	{
		name: "typescript typecheck",
		run: forTarget("typescript", () =>
			shell(
				join(ENGINE, "node_modules", ".bin", "tsc"),
				[
					"--noEmit",
					"--strict",
					"--target",
					"es2022",
					// The generated capability defaults use the platform's own fetch, timers and crypto,
					// which live in the DOM library and are global in Node 20 and later.
					"--lib",
					"es2022,dom",
					"--module",
					"nodenext",
					"--moduleResolution",
					"nodenext",
					"--allowImportingTsExtensions",
					"--skipLibCheck",
					...generatedTypeScript(join(project, "out", "typescript")),
				],
				join(project, "out", "typescript"),
			),
		),
	},
	{
		// The generated TypeScript is shipped to a browser by a tree-shakeable package, so its size
		// is a result this pipeline has to check rather than a trade to remember. `size.ts` measures
		// what a consumer's bundler would produce for a single-import entry point and compares it
		// with the committed `SIZE.json`; a per-export regression past the budget fails here.
		name: "typescript size",
		run: forTarget("typescript", () => shell(process.execPath, [join(ENGINE, "scripts", "size.ts"), project, "--check"], project)),
	},
	{
		name: "python compile",
		run: forTarget("python", () => shell("python3", ["-m", "compileall", "-q", "."], join(project, "out", "python"))),
	},
	{
		name: "go vet",
		run: forTarget("go", () => shell("go", ["vet", "./..."], join(project, "out", "go"))),
	},
	{
		name: "rust build",
		run: forTarget("rust", () => shell("cargo", ["build", "--offline", "--release"], join(project, "out", "rust"))),
	},
	{
		name: "rust clippy",
		run: forTarget("rust", () => shell("cargo", ["clippy", "--offline", "--", "-D", "warnings"], join(project, "out", "rust"))),
	},
	{
		name: "rust fmt check",
		run: forTarget("rust", () => shell("cargo", ["fmt", "--check"], join(project, "out", "rust"))),
	},
	{
		name: "conformance",
		run: () => {
			const runner = join(project, "conformance", "run.ts");
			if (!existsSync(runner)) return { ok: true, output: "skipped: no conformance runner" };
			return shell(
				process.execPath,
				["--import", join(project, "conformance", "sloppy-imports.mjs"), runner],
				project,
			);
		},
	},
	{
		// Every step above proves the source *compiles* — this proves it *runs*: the migrated
		// utilities under `source/`, imported and called in plain Node, no engine involved. See
		// `conformance/run-source.ts` for exactly which utilities that covers and why the rest
		// cannot run yet.
		name: "conformance (source, no engine)",
		run: () => {
			const runner = join(project, "conformance", "run-source.ts");
			if (!existsSync(runner)) return { ok: true, output: "skipped: no source conformance runner" };
			return shell(
				process.execPath,
				["--import", join(project, "conformance", "sloppy-imports.mjs"), runner],
				project,
			);
		},
	},
];

let failed = false;
for (const step of steps) {
	const result = step.run();
	const status = result.ok ? "ok" : "FAILED";
	process.stdout.write(`${status.padEnd(7)} ${step.name}\n`);
	if (!result.ok || (result.output ?? "").startsWith("skipped")) {
		const output = (result.output ?? "").trim();
		if (output !== "") process.stdout.write(`${output.split("\n").map((line) => `        ${line}`).join("\n")}\n`);
	}
	if (!result.ok) failed = true;
}

if (failed) process.exitCode = 1;
