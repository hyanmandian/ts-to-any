/**
 * The F# (.NET) backend.
 *
 * F# 8 / .NET 8, standard library only. Integers are `int64` everywhere (see
 * `docs/targets/fsharp.md` — the same choice Go and Rust already made, for the same reason: this
 * engine's own admission rules never prove a range that leaves ±(2^63 − 1)). `List<T>` is
 * `ResizeArray<T>` (.NET's own `List<T>`), matching the mutable-imperative rendering this target
 * chose: `let mutable`, real `for`/`for … in … do` loops.
 *
 * `break` and `continue` have no expression form in F# — the language left them out on purpose —
 * so a loop that needs one runs its full, checker-proven trip count and guards its remaining work
 * with a boolean sentinel scoped to that loop (`docs/targets/fsharp.md`, "The mutable-vs-functional
 * decision"). A guard-clause chain that never crosses a loop renders as nested `if`/`else`
 * *expressions* instead — F#'s own direct form for "return early" — and the whole function falls
 * back to a `__result`/`__returned` sentinel pair only when some `return` inside it is reachable
 * from inside a loop, uniformly for that one function, never mixed within it.
 */

import type { Backend, DriverEntry, SupportNeeds } from "../../backend/generate.ts";
import { ENGINE_VERSION } from "../../backend/generate.ts";
import type { TargetSpec } from "../../backend/lower.ts";
import type { Candidate } from "../../backend/select.ts";
import { LoweringTable, argIsAscii } from "../../backend/select.ts";
import { asciiString } from "../../backend/tast.ts";
import type { TExpr, TFunc, TModule, TRecord, TStmt } from "../../backend/tast.ts";
import type { CProgram } from "../../core/ir.ts";
import { printRegex } from "../../regex.ts";
import { TRIM_CODE_POINTS } from "../../intrinsics/index.ts";
import type { SemType } from "../../types.ts";
import type { Value } from "../../values.ts";

export const FSHARP_CONFIG = {
	baseline: "F# 8 / .NET 8",
	fileExtension: ".fs",
	dependencies: [] as string[],
	formatter: "(none — dotnet format does not support F#; see docs/targets/fsharp.md)",
	linters: ["dotnet build -warnaserror"],
};

/* ------------------------------------------------------------------ *
 * Naming
 * ------------------------------------------------------------------ */

const FSHARP_KEYWORDS = new Set([
	"abstract", "and", "as", "assert", "base", "begin", "class", "default", "delegate", "do", "done",
	"downcast", "downto", "elif", "else", "end", "exception", "extern", "false", "finally", "for",
	"fun", "function", "global", "if", "in", "inherit", "inline", "interface", "internal", "lazy",
	"let", "match", "member", "module", "mutable", "namespace", "new", "not", "null", "of", "open",
	"or", "override", "private", "public", "rec", "return", "sig", "static", "struct", "then", "to",
	"true", "try", "type", "upcast", "use", "val", "void", "when", "while", "with", "yield",
	"atomic", "break", "checked", "component", "const", "constraint", "constructor", "continue",
	"eager", "event", "external", "fixed", "functor", "include", "method", "mixin", "object",
	"parallel", "process", "protected", "pure", "sealed", "tailcall", "trait", "virtual", "volatile",
]);

function escapeKeyword(name: string): string {
	return FSHARP_KEYWORDS.has(name) ? `\`\`${name}\`\`` : name;
}

function camel(name: string): string {
	const cleaned = name.replaceAll("$", "_").replace(/[-](.)/g, (_m, char: string) => char.toUpperCase());
	const lowered = cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
	return escapeKeyword(lowered);
}

function pascal(name: string): string {
	const cleaned = name.replaceAll("$", "_").replace(/[-_](.)/g, (_m, char: string) => char.toUpperCase());
	const upper = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	return escapeKeyword(upper);
}

/** The module's flat file identifier, and the `module Core.X` name it carries. */
function fsModuleIdent(sourcePath: string): string {
	return sourcePath
		.split(/[^a-zA-Z0-9]+/u)
		.filter((part) => part !== "")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export function fsType(type: SemType): string {
	switch (type.kind) {
		case "Bool":
			return "bool";
		case "Int":
		case "Decimal":
		case "CivilDate":
		case "Instant":
		case "Duration":
			return "int64";
		case "Float":
			return "float";
		case "String":
			return "string";
		case "List":
			return `ResizeArray<${fsType(type.elem)}>`;
		case "Option":
			return `${fsType(type.inner)} option`;
		case "Record":
			return type.name === "Capabilities" ? "Capabilities" : pascal(type.name);
		case "Enum":
			return "string";
		case "Union":
			return pascal(type.name);
		case "Lambda":
			return `(${type.params.map(fsType).join(" -> ")}${type.params.length === 0 ? "unit" : ""} -> ${fsType(type.ret)})`;
		case "Void":
			return "unit";
		case "Never":
			return "'a";
		default: {
			const exhaustive: never = type;
			return exhaustive;
		}
	}
}

/* ------------------------------------------------------------------ *
 * Small text helpers
 * ------------------------------------------------------------------ */

const raw = (text: string): TExpr => ({ kind: "raw", text });

function binary(op: string): Candidate["emit"] {
	return (args) => ({ kind: "binary", op, left: args[0]!, right: args[1]! });
}

const cheap = { alloc: "none", time: "constant" } as const;
const linear = { alloc: "none", time: "linear" } as const;
const allocating = { alloc: "one", time: "linear" } as const;
const scalarPass = { alloc: "many", time: "linear" } as const;

function scaleOf(type: SemType | undefined): number {
	return type !== undefined && type.kind === "Int" ? Number(type.lo) : 0;
}

/** `TRIM_CODE_POINTS` as an F# `char[]` literal — every one of the 25 points fits a UTF-16 char. */
function trimCharsLiteral(): string {
	const chars = TRIM_CODE_POINTS.map((point) => `'\\u${point.toString(16).padStart(4, "0")}'`).join("; ");
	return `[| ${chars} |]`;
}

/**
 * `[\--/]` — the shared `"javascript"` dialect's own spelling of a class range whose low end is
 * the hyphen itself, `\-` (escaped, since a bare `-` there would open a range) immediately
 * followed by the range operator's own `-` — is read correctly by JavaScript, Python and RE2, but
 * **not** by .NET: verified directly (`[\--/]` matches `-` and `/` but not `.`, the scalar between
 * them, where `[\x2d-/]` matches all three). `\-` immediately followed by the range dash is the
 * one shape this rewrites, to the equivalent `\x2d` hex escape .NET reads as an ordinary range
 * start; nothing else a `\-` singleton (with no dash after it) or any other escape ever produces
 * this exact three-character sequence, so the rewrite cannot misfire on unrelated text. The CPF
 * and CNPJ mask patterns in `core/source` both have a `.-/ ` run in their separator class and hit
 * this exactly, which is how it was found — not a defect anticipated ahead of time. See
 * `docs/targets/fsharp.md`.
 */
function dotNetClassRangeFix(pattern: string): string {
	return pattern.replaceAll("\\--", "\\x2d-");
}

/* ------------------------------------------------------------------ *
 * Capability table
 * ------------------------------------------------------------------ */

export const FSHARP_CANDIDATES: readonly Candidate[] = [
	...["add:+", "sub:-", "mul:*", "div:/", "mod:%"].map((entry) => {
		const [op, symbol] = entry.split(":") as [string, string];
		return {
			op: `int.${op}`,
			impl: "native" as const,
			cost: cheap,
			because: op === "div" || op === "mod" ? "`/` and `%` on `int64` truncate, which is the Core's rule" : undefined,
			emit: binary(symbol),
		};
	}),
	...["add:+", "sub:-", "mul:*", "div:/"].map((entry) => {
		const [op, symbol] = entry.split(":") as [string, string];
		return { op: `float.${op}`, impl: "native" as const, cost: cheap, emit: binary(symbol) };
	}),
	{ op: "int.neg", impl: "native", cost: cheap, emit: (args) => raw(`(-${print(args[0]!)})`) },
	{ op: "float.neg", impl: "native", cost: cheap, emit: (args) => raw(`(-${print(args[0]!)})`) },
	{ op: "int.abs", impl: "native", cost: cheap, emit: (args) => raw(`(abs ${print(args[0]!)})`) },
	{ op: "int.min", impl: "native", cost: cheap, emit: (args) => raw(`(min ${print(args[0]!)} ${print(args[1]!)})`) },
	{ op: "int.max", impl: "native", cost: cheap, emit: (args) => raw(`(max ${print(args[0]!)} ${print(args[1]!)})`) },
	...["lt:<", "le:<=", "gt:>", "ge:>="].flatMap((entry) => {
		const [op, symbol] = entry.split(":") as [string, string];
		return [
			{ op: `int.${op}`, impl: "native" as const, cost: cheap, emit: binary(symbol) },
			{ op: `float.${op}`, impl: "native" as const, cost: cheap, emit: binary(symbol) },
		];
	}),
	{ op: "float.fromInt", impl: "native", cost: cheap, emit: (args) => raw(`(float ${print(args[0]!)})`) },
	{ op: "core.eq", impl: "native", cost: cheap, emit: binary("=") },

	{
		op: "opt.isNone",
		impl: "native",
		cost: cheap,
		emit: (args) => raw(`(Option.isNone ${print(args[0]!)})`),
	},
	{ op: "opt.unwrap", impl: "native", cost: cheap, emit: (args) => raw(`(${print(args[0]!)}).Value`) },
	{ op: "opt.some", impl: "native", cost: cheap, emit: (args) => raw(`(Some ${print(args[0]!)})`) },
	{
		op: "opt.orElse",
		impl: "native",
		cost: cheap,
		emit: (args) => raw(`(defaultArg ${print(args[0]!)} ${print(args[1]!)})`),
	},

	{
		op: "str.len",
		impl: "native",
		requires: argIsAscii(0),
		because: "`String.Length` counts UTF-16 code units, which equals the scalar count only for ASCII",
		cost: cheap,
		emit: (args) => raw(`(int64 (${print(args[0]!)}).Length)`),
	},
	{
		op: "str.len",
		impl: "native",
		because: "`EnumerateRunes` decodes UTF-16 into scalars, .NET's own code-point iterator",
		cost: allocating,
		emit: (args) => raw(`(int64 (Seq.length ((${print(args[0]!)}).EnumerateRunes())))`),
	},
	{ op: "str.concat", impl: "native", cost: allocating, emit: binary("+") },
	{
		op: "str.codeAt",
		impl: "native",
		requires: argIsAscii(0),
		because: "indexing a UTF-16 string yields one code unit",
		cost: cheap,
		emit: (args) => raw(`(int64 (int (${print(args[0]!)}).[int ${print(args[1]!)}]))`),
	},
	{
		op: "str.charAt",
		impl: "native",
		requires: argIsAscii(0),
		cost: cheap,
		emit: (args) => raw(`(string (${print(args[0]!)}).[int ${print(args[1]!)}])`),
	},
	{
		op: "str.codeAtOpt",
		impl: "native",
		requires: argIsAscii(0),
		cost: cheap,
		emit: (args) =>
			raw(
				`(if ${print(args[1]!)} >= 0L && ${print(args[1]!)} < int64 (${print(args[0]!)}).Length then Some (int64 (int (${print(args[0]!)}).[int ${print(args[1]!)}])) else None)`,
			),
	},
	{
		op: "str.charAtOpt",
		impl: "native",
		requires: argIsAscii(0),
		cost: cheap,
		emit: (args) =>
			raw(
				`(if ${print(args[1]!)} >= 0L && ${print(args[1]!)} < int64 (${print(args[0]!)}).Length then Some (string (${print(args[0]!)}).[int ${print(args[1]!)}]) else None)`,
			),
	},
	{
		op: "str.slice",
		impl: "native",
		requires: argIsAscii(0),
		because: "`Substring` cuts at UTF-16 boundaries",
		cost: allocating,
		emit: (args) =>
			raw(
				`(${print(args[0]!)}).Substring(int ${print(args[1]!)}, int (${print(args[2]!)} - ${print(args[1]!)}))`,
			),
	},
	{
		op: "str.indexOf",
		impl: "native",
		requires: argIsAscii(0),
		because: "`IndexOf` returns a UTF-16 offset",
		cost: linear,
		emit: (args) => raw(`(int64 ((${print(args[0]!)}).IndexOf(${print(args[1]!)}, System.StringComparison.Ordinal)))`),
	},
	{
		op: "str.contains",
		impl: "native",
		cost: linear,
		emit: (args) => raw(`(${print(args[0]!)}).Contains(${print(args[1]!)}, System.StringComparison.Ordinal)`),
	},
	{
		op: "str.startsWith",
		impl: "native",
		cost: linear,
		emit: (args) => raw(`(${print(args[0]!)}).StartsWith(${print(args[1]!)}, System.StringComparison.Ordinal)`),
	},
	{
		op: "str.endsWith",
		impl: "native",
		cost: linear,
		emit: (args) => raw(`(${print(args[0]!)}).EndsWith(${print(args[1]!)}, System.StringComparison.Ordinal)`),
	},
	{
		op: "str.repeat",
		impl: "native",
		cost: allocating,
		emit: (args) => raw(`(String.replicate (int ${print(args[1]!)}) ${print(args[0]!)})`),
	},
	{
		op: "str.padStart",
		impl: "library",
		cost: allocating,
		emit: (args) => raw(`(padStart ${print(args[0]!)} ${print(args[1]!)} ${print(args[2]!)})`),
	},
	{
		op: "str.trim",
		impl: "native",
		because: "`Trim` takes the cut set explicitly, so the 25 code points are exact",
		cost: cheap,
		emit: (args) => raw(`(${print(args[0]!)}).Trim(${trimCharsLiteral()})`),
	},
	{
		op: "str.asciiUpper",
		impl: "native",
		requires: argIsAscii(0),
		because: "`ToUpperInvariant` is only ASCII-equivalent on ASCII input",
		cost: allocating,
		emit: (args) => raw(`(${print(args[0]!)}).ToUpperInvariant()`),
	},
	{
		op: "str.asciiLower",
		impl: "native",
		requires: argIsAscii(0),
		because: "`ToLowerInvariant` is only ASCII-equivalent on ASCII input",
		cost: allocating,
		emit: (args) => raw(`(${print(args[0]!)}).ToLowerInvariant()`),
	},
	{
		op: "str.asciiUpper",
		impl: "native",
		because: "`String.map` is one pass over UTF-16 chars, mapping only a-z, which is sound for any input including a surrogate half",
		cost: allocating,
		emit: (args) => raw(`(${print(args[0]!)} |> String.map (fun c -> if c >= 'a' && c <= 'z' then char (int c - 32) else c))`),
	},
	{
		op: "str.asciiLower",
		impl: "native",
		because: "`String.map` is one pass over UTF-16 chars, mapping only A-Z, which is sound for any input including a surrogate half",
		cost: allocating,
		emit: (args) => raw(`(${print(args[0]!)} |> String.map (fun c -> if c >= 'A' && c <= 'Z' then char (int c + 32) else c))`),
	},
	{
		op: "str.compare",
		impl: "native",
		requires: (args) => argIsAscii(0)(args) && argIsAscii(1)(args),
		because: "`String.CompareOrdinal` compares UTF-16 code units, so astral scalars would sort before U+E000",
		cost: cheap,
		emit: (args) => raw(`(compareOrdinal ${print(args[0]!)} ${print(args[1]!)})`),
	},
	{
		op: "str.compare",
		impl: "portable",
		cost: scalarPass,
		sourceFn: "std/strings::compareScalars",
		emit: (args, _types, ctx) => raw(`(${ctx.nameOf("std/strings::compareScalars")} ${print(args[0]!)} ${print(args[1]!)})`),
	},
	{
		op: "str.codePoints",
		impl: "native",
		because: "`EnumerateRunes` is .NET's own code-point iterator",
		cost: allocating,
		emit: (args) => raw(`(ResizeArray((${print(args[0]!)}).EnumerateRunes() |> Seq.map (fun r -> int64 r.Value)))`),
	},
	{
		op: "str.fromCodePoints",
		impl: "library",
		cost: allocating,
		emit: (args) => raw(`(fromCodePoints ${print(args[0]!)})`),
	},
	{
		op: "str.asAscii",
		impl: "native",
		cost: linear,
		emit: (args) => raw(`(if ${print(args[0]!)} |> Seq.forall (fun c -> int c < 0x80) then Some ${print(args[0]!)} else None)`),
	},
	{
		op: "str.asDigits",
		impl: "native",
		cost: linear,
		emit: (args) =>
			raw(
				`(if ${print(args[0]!)} <> "" && ${print(args[0]!)} |> Seq.forall (fun c -> c >= '0' && c <= '9') then Some ${print(args[0]!)} else None)`,
			),
	},
	{
		op: "str.split",
		impl: "native",
		cost: allocating,
		emit: (args) => raw(`(ResizeArray((${print(args[0]!)}).Split([| ${print(args[1]!)} |], System.StringSplitOptions.None)))`),
	},
	{
		op: "str.join",
		impl: "native",
		cost: allocating,
		emit: (args) => raw(`(System.String.Join(${print(args[1]!)}, ${print(args[0]!)}))`),
	},
	{ op: "str.fromInt", impl: "native", cost: allocating, emit: (args) => raw(`(string ${print(args[0]!)})`) },
	{
		op: "str.parseInt",
		impl: "native",
		cost: linear,
		emit: (args) => raw(`(parseDigits ${print(args[0]!)})`),
	},

	{ op: "seq.at", impl: "library", cost: cheap, emit: (args) => raw(`(at ${print(args[0]!)} ${print(args[1]!)})`) },
	{
		op: "str.asciiUpper",
		impl: "portable",
		cost: scalarPass,
		sourceFn: "std/strings::asciiUpperAll",
		emit: (args, _types, ctx) => raw(`(${ctx.nameOf("std/strings::asciiUpperAll")} ${print(args[0]!)})`),
	},
	{
		op: "str.asciiLower",
		impl: "portable",
		cost: scalarPass,
		sourceFn: "std/strings::asciiLowerAll",
		emit: (args, _types, ctx) => raw(`(${ctx.nameOf("std/strings::asciiLowerAll")} ${print(args[0]!)})`),
	},
	{ op: "seq.len", impl: "native", cost: cheap, emit: (args) => raw(`(int64 (${print(args[0]!)}).Count)`) },
	{ op: "seq.get", impl: "native", cost: cheap, emit: (args) => raw(`(${print(args[0]!)}).[int ${print(args[1]!)}]`) },
	{ op: "seq.push", impl: "native", cost: cheap, emit: (args) => raw(`(${print(args[0]!)}).Add(${print(args[1]!)})`) },
	{ op: "seq.sum", impl: "native", cost: linear, emit: (args) => raw(`(Seq.sum ${print(args[0]!)})`) },
	{ op: "seq.contains", impl: "native", cost: linear, emit: (args) => raw(`(${print(args[0]!)}).Contains(${print(args[1]!)})`) },
	{ op: "seq.indexOf", impl: "native", cost: linear, emit: (args) => raw(`(int64 ((${print(args[0]!)}).IndexOf(${print(args[1]!)})))`) },
	{ op: "seq.concat", impl: "native", cost: allocating, emit: (args) => raw(`(ResizeArray(Seq.append ${print(args[0]!)} ${print(args[1]!)}))`) },
	{
		op: "seq.slice",
		impl: "native",
		cost: allocating,
		emit: (args) =>
			raw(`(${print(args[0]!)}).GetRange(int ${print(args[1]!)}, int (${print(args[2]!)} - ${print(args[1]!)}))`),
	},
	{
		op: "seq.reverse",
		impl: "native",
		cost: allocating,
		emit: (args) => raw(`(let __r = ResizeArray(${print(args[0]!)}) in __r.Reverse(); __r)`),
	},
	{
		op: "seq.sortStable",
		impl: "library",
		because: "`Seq.sortWith` is a stable sort",
		cost: { alloc: "one", time: "nlogn" },
		emit: (args) => raw(`(sortedStable ${print(args[0]!)} ${print(args[1]!)})`),
	},
	{
		op: "seq.sortStableBy",
		impl: "native",
		because: "`Seq.sortBy` is a stable sort",
		cost: { alloc: "one", time: "nlogn" },
		emit: (args) => raw(`(ResizeArray(${print(args[0]!)} |> Seq.sortBy ${print(args[1]!)}))`),
	},
	{ op: "seq.map", impl: "native", cost: allocating, emit: (args) => raw(`(ResizeArray(${print(args[0]!)} |> Seq.map ${print(args[1]!)}))`) },
	{ op: "seq.filter", impl: "native", cost: allocating, emit: (args) => raw(`(ResizeArray(${print(args[0]!)} |> Seq.filter ${print(args[1]!)}))`) },
	{ op: "seq.any", impl: "native", cost: linear, emit: (args) => raw(`(${print(args[0]!)} |> Seq.exists ${print(args[1]!)})`) },
	{ op: "seq.all", impl: "native", cost: linear, emit: (args) => raw(`(${print(args[0]!)} |> Seq.forall ${print(args[1]!)})`) },
	{ op: "seq.find", impl: "native", cost: linear, emit: (args) => raw(`(${print(args[0]!)} |> Seq.tryFind ${print(args[1]!)})`) },

	{ op: "dec.fromScaled", impl: "native", cost: cheap, emit: (args) => args[0]! },
	{ op: "dec.fromInt", impl: "native", cost: cheap, emit: (args, types) => raw(`(${print(args[0]!)} * ${10 ** scaleOf(types[1])}L)`) },
	{ op: "dec.add", impl: "native", cost: cheap, emit: binary("+") },
	{ op: "dec.sub", impl: "native", cost: cheap, emit: binary("-") },
	{ op: "dec.mul", impl: "native", cost: cheap, emit: binary("*") },
	{ op: "dec.compare", impl: "native", cost: cheap, emit: (args) => raw(`(compareInts ${print(args[0]!)} ${print(args[1]!)})`) },
	{ op: "dec.isNegative", impl: "native", cost: cheap, emit: (args) => raw(`(${print(args[0]!)} < 0L)`) },
	{ op: "dec.abs", impl: "native", cost: cheap, emit: (args) => raw(`(abs ${print(args[0]!)})`) },
	{ op: "dec.unscaled", impl: "native", cost: cheap, emit: (args) => args[0]! },

	{
		op: "date.clampEpochDays",
		impl: "native",
		cost: cheap,
		emit: (args) => raw(`(min (max ${print(args[0]!)} -719162L) 2932896L)`),
	},
	{ op: "date.toEpochDays", impl: "native", cost: cheap, emit: (args) => args[0]! },
	{
		op: "date.fromEpochDays",
		impl: "native",
		cost: cheap,
		emit: (args) => raw(`(if ${print(args[0]!)} >= -719162L && ${print(args[0]!)} <= 2932896L then Some ${print(args[0]!)} else None)`),
	},
	{
		op: "date.fromYmd",
		impl: "portable",
		cost: linear,
		sourceFn: "std/date::ymdToDays",
		emit: (args, _types, ctx) => raw(`(${ctx.nameOf("std/date::ymdToDays")} ${args.map((a) => `(${print(a)})`).join(" ")})`),
	},
	{ op: "date.year", impl: "portable", cost: cheap, sourceFn: "std/date::yearFromDays", emit: (args, _types, ctx) => raw(`(${ctx.nameOf("std/date::yearFromDays")} ${print(args[0]!)})`) },
	{ op: "date.month", impl: "portable", cost: cheap, sourceFn: "std/date::monthFromDays", emit: (args, _types, ctx) => raw(`(${ctx.nameOf("std/date::monthFromDays")} ${print(args[0]!)})`) },
	{ op: "date.day", impl: "portable", cost: cheap, sourceFn: "std/date::dayFromDays", emit: (args, _types, ctx) => raw(`(${ctx.nameOf("std/date::dayFromDays")} ${print(args[0]!)})`) },
	{
		op: "date.addDays",
		impl: "native",
		cost: cheap,
		emit: (args) => {
			const sum = `(${print(args[0]!)} + ${print(args[1]!)})`;
			return raw(`(if ${sum} >= -719162L && ${sum} <= 2932896L then Some ${sum} else None)`);
		},
	},
	{ op: "date.diffDays", impl: "native", cost: cheap, emit: binary("-") },
	{ op: "date.compare", impl: "native", cost: cheap, emit: (args) => raw(`(compareInts ${print(args[0]!)} ${print(args[1]!)})`) },
	{ op: "date.dayOfWeek", impl: "native", cost: cheap, emit: (args) => raw(`((((${print(args[0]!)} + 3L) % 7L + 7L) % 7L) + 1L)`) },
	{
		op: "date.isLeapYear",
		impl: "native",
		cost: cheap,
		emit: (args) =>
			raw(`((${print(args[0]!)} % 4L = 0L && ${print(args[0]!)} % 100L <> 0L) || ${print(args[0]!)} % 400L = 0L)`),
	},

	{
		op: "re.retain",
		impl: "native",
		because: "`String.filter` is one pass over UTF-16 chars; every class this project uses is ASCII-only",
		cost: allocating,
		emit: (args, _types, ctx) => {
			const ranges = ctx.regex === undefined || ctx.regex.node.kind !== "class" ? [] : ctx.regex.node.ranges;
			const test = (name: string): string =>
				ranges.length === 0
					? "false"
					: ranges.map((range) => (range.lo === range.hi ? `${name} = ${range.lo}` : `(${name} >= ${range.lo} && ${name} <= ${range.hi})`)).join(" || ");
			return raw(`(${print(args[0]!)} |> String.filter (fun __c -> let __c = int __c in ${test("__c")}))`);
		},
	},
	{
		op: "re.test",
		impl: "native",
		because: "the normalized pattern is inside the compatibility subset — .NET regex reads \\uXXXX the same as the shared `\"javascript\"` dialect for every scalar up to U+FFFF; see docs/targets/fsharp.md for the (unreached) gap above that, and for the one further .NET-specific rewrite this candidate applies",
		cost: linear,
		deps: ["System.Text.RegularExpressions"],
		emit: (args, _types, ctx) => {
			const pattern = ctx.regex === undefined ? "" : dotNetClassRangeFix(printRegex(ctx.regex.node, "javascript"));
			return raw(`(System.Text.RegularExpressions.Regex.IsMatch(${print(args[0]!)}, ${asciiString(`\\A${pattern}\\z`)}))`);
		},
	},

	{
		op: "http.request",
		impl: "native",
		cost: { alloc: "many", time: "linear" },
		emit: (args, _types, ctx) => raw(`(${print(ctx.env())}).Request(${print(args[0]!)})`),
	},
	{ op: "clock.now", impl: "native", cost: cheap, emit: (_args, _types, ctx) => raw(`(${print(ctx.env())}).Now()`) },
	{ op: "clock.sleep", impl: "native", cost: cheap, emit: (args, _types, ctx) => raw(`(${print(ctx.env())}).Sleep(${print(args[0]!)})`) },
	{ op: "clock.millis", impl: "native", cost: cheap, emit: (args) => args[0]! },
	{ op: "clock.durationMillis", impl: "native", cost: cheap, emit: (args) => args[0]! },
	{ op: "clock.elapsed", impl: "native", cost: cheap, emit: (args) => raw(`(max 0L (${print(args[1]!)} - ${print(args[0]!)}))`) },
	{ op: "random.nextU32", impl: "native", cost: cheap, emit: (_args, _types, ctx) => raw(`(${print(ctx.env())}).NextU32()`) },
	{
		op: "task.race",
		impl: "library",
		because: "one `Task` per branch, `Task.WaitAny` over the still-pending ones, is the idiomatic .NET shape",
		cost: { alloc: "many", time: "linear" },
		emit: (args) => raw(`(raceFirstSome ${print(args[0]!)})`),
	},
];

/* ------------------------------------------------------------------ *
 * Spec
 * ------------------------------------------------------------------ */

export const FSHARP_SPEC: TargetSpec = {
	name: "fsharp",
	table: new LoweringTable(FSHARP_CANDIDATES),
	naming: {
		func: (name, exported) => (exported ? pascal(name) : camel(name)),
		value: (name) => camel(name),
		field: (name) => pascal(name),
		type: (name) => pascal(name),
		module: (path) => `${path.split("/").join("-")}.fs`,
	},
	// The mutable-imperative choice: a fold/map/filter renders as a loop with a mutable
	// accumulator/`ResizeArray`, never `Seq.fold`/`Seq.map`/`Seq.filter` over a lambda — see
	// docs/targets/fsharp.md.
	loopCombinators: new Set(["seq.fold", "seq.map", "seq.filter"]),
	// F#'s `if … then … else …` is an expression, so `cond` never needs hoisting into statements.
	statementTernary: false,
	// `Fail<E>` is a real .NET exception, not a second return value — like TypeScript and Python.
	errorsAsValues: false,
	// A single blocking round trip per capability call; `task.race` uses `Task`/`Task.WaitAny`
	// directly rather than colouring every caller `async` — see docs/targets/fsharp.md.
	asyncColouring: false,
	envType: { kind: "Record", name: "Capabilities" },
};

/* ------------------------------------------------------------------ *
 * Printer: leaf expressions
 * ------------------------------------------------------------------ */

export function print(expr: TExpr): string {
	switch (expr.kind) {
		case "lit":
			return literal(expr.value, expr.type);
		case "name":
			return expr.name;
		case "raw":
			return expr.text;
		case "call": {
			// F# functions declared `let f (a: T1) (b: T2) = …` are curried: calling one with a
			// comma-tupled `f(a, b)` (the shape every other target's own call convention uses) would
			// pass a *single tuple* as F#'s first curried argument instead of two arguments — wrong
			// whenever a callee takes more than one parameter. Every argument is applied separately,
			// each parenthesized so a complex argument expression is never mistaken for more than one.
			const args = expr.args.length === 0 ? "()" : expr.args.map((arg) => `(${print(arg)})`).join(" ");
			// Wrapped as a whole, not only the callee's own arguments: F# reads `not f (x) (y)` as
			// `not` applied to `f`, `(x)` and `(y)` as three separate arguments — "high precedence
			// application" only reaches the identifier immediately to its left — so a call used as
			// the argument of a leading keyword (`not`, `abs`, `string`, …) needs its own parens too.
			return `(${print(expr.callee)} ${args})`;
		}
		case "method":
			return `((${print(expr.target)}).${pascal(expr.name)}(${expr.args.map(print).join(", ")}))`;
		case "member":
			return `((${print(expr.target)}).${expr.name})`;
		case "index":
			return `((${print(expr.target)}).[int ${print(expr.index)}])`;
		case "binary":
			return `(${print(expr.left)} ${fsOperator(expr.op)} ${print(expr.right)})`;
		case "unary": {
			if (expr.op === "!") {
				// `Option.isNone x` negates to `Option.isSome x` — a plain string match, since the
				// candidate above always emits exactly this shape for `opt.isNone`.
				const inner = print(expr.operand);
				const isNoneMatch = /^\(Option\.isNone (.*)\)$/u.exec(inner);
				if (isNoneMatch !== null) return `(Option.isSome ${isNoneMatch[1]})`;
				if (expr.operand.kind === "binary" && (expr.operand.op === "=" || expr.operand.op === "==" || expr.operand.op === "===")) {
					return `(${print(expr.operand.left)} <> ${print(expr.operand.right)})`;
				}
				return `(not ${inner})`;
			}
			return `(${expr.op}${print(expr.operand)})`;
		}
		case "ternary":
			return `(if ${print(expr.test)} then ${print(expr.then)} else ${print(expr.otherwise)})`;
		case "list":
			// Parenthesized as a whole: `ResizeArray([ … ])` is itself a constructor application,
			// which needs the same protection a bare `call`/`method` result does (see "call" above)
			// when it is passed on as a juxtaposed argument, e.g. `fromCodePoints ResizeArray([ … ])`.
			return expr.items.length === 0 ? "(ResizeArray())" : `(ResizeArray([ ${expr.items.map(print).join("; ")} ]))`;
		case "record":
			return `{ ${expr.fields.map((field) => `${pascal(field.name)} = ${print(field.value)}`).join("; ")} }`;
		case "lambda": {
			const params = expr.params.map((param) => param.name).join(" ");
			return `(fun ${params === "" ? "()" : params} -> ${compileBody(expr.body, undefined)})`;
		}
		case "none":
			return "None";
		case "zero":
			return `Unchecked.defaultof<${fsType(expr.type)}>`;
		case "some":
			return `(Some ${print(expr.inner)})`;
		default: {
			const exhaustive: never = expr;
			return exhaustive;
		}
	}
}

function fsOperator(op: string): string {
	switch (op) {
		case "===":
		case "==":
			return "=";
		case "!==":
		case "!=":
			return "<>";
		case "&&":
			return "&&";
		case "||":
			return "||";
		default:
			return op;
	}
}

function literal(value: Value, type?: SemType): string {
	if (typeof value === "bigint") return `${value}L`;
	if (typeof value === "string") return asciiString(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Number.isInteger(value) ? `${value}.0` : `${value}`;
	if (Array.isArray(value)) {
		const elem = type !== undefined && type.kind === "List" ? type.elem : undefined;
		if (value.length === 0) return "(ResizeArray())";
		return `(ResizeArray([ ${value.map((item) => literal(item, elem)).join("; ")} ]))`;
	}
	return "None";
}

/* ------------------------------------------------------------------ *
 * Printer: statements, control flow, and the mutable-vs-CPS split
 * ------------------------------------------------------------------ */

const INDENT = "    ";
function pad(depth: number): string {
	return INDENT.repeat(depth);
}

/** One F# value pattern per switch-case value: string literals joined with `|`. */
function valuePattern(values: readonly Value[]): string {
	return values.map((value) => literal(value)).join(" | ");
}

/** Drops a switch case's own closing `break` (see `docs/semantics.md` §7): it is never a loop exit. */
function dropCaseCloser(body: readonly TStmt[]): readonly TStmt[] {
	if (body.length > 0 && body[body.length - 1]!.kind === "break") return body.slice(0, -1);
	return body;
}

/** Whether a `return` is reachable anywhere within `stmts`, including inside a nested loop. */
function containsReturn(stmts: readonly TStmt[]): boolean {
	return stmts.some((s) => {
		switch (s.kind) {
			case "return":
				return true;
			case "if":
				return containsReturn(s.then) || containsReturn(s.otherwise);
			case "switch":
				return s.cases.some((c) => containsReturn(dropCaseCloser(c.body))) || (s.otherwise !== undefined && containsReturn(dropCaseCloser(s.otherwise)));
			case "for":
			case "forEach":
				return containsReturn(s.body);
			default:
				return false;
		}
	});
}

/** Whether some loop reachable from `stmts` (not crossing a lambda) itself contains a `return`. */
function hasLoopWithReturn(stmts: readonly TStmt[]): boolean {
	return stmts.some((s) => {
		switch (s.kind) {
			case "for":
			case "forEach":
				return containsReturn(s.body) || hasLoopWithReturn(s.body);
			case "if":
				return hasLoopWithReturn(s.then) || hasLoopWithReturn(s.otherwise);
			case "switch":
				return s.cases.some((c) => hasLoopWithReturn(dropCaseCloser(c.body))) || (s.otherwise !== undefined && hasLoopWithReturn(dropCaseCloser(s.otherwise)));
			default:
				return false;
		}
	});
}

/**
 * Whether a `break`/`continue` aimed at *this* loop is reachable in `stmts`. A `break` inside a
 * switch case never counts (it closes the case, `docs/semantics.md` §7); a `continue` there still
 * does. Crossing into a nested loop stops the search — that loop's own exits are its own concern.
 */
function hasLoopSignal(stmts: readonly TStmt[], countBreak: boolean): boolean {
	return stmts.some((s) => {
		switch (s.kind) {
			case "break":
				return countBreak;
			case "continue":
				return true;
			case "if":
				return hasLoopSignal(s.then, countBreak) || hasLoopSignal(s.otherwise, countBreak);
			case "switch":
				return s.cases.some((c) => hasLoopSignal(dropCaseCloser(c.body), false)) || (s.otherwise !== undefined && hasLoopSignal(dropCaseCloser(s.otherwise), false));
			case "for":
			case "forEach":
				return false;
			default:
				return false;
		}
	});
}

/**
 * `raise` is itself an expression of type `'a` in F#, unifying with whatever context it sits in,
 * so a `throw` — a genuine, unwinding exit, unlike the simulated `break`/`continue`/`return` this
 * target renders with sentinels — never needs any of that machinery: it prints the same way in
 * CPS mode and in guarded-block mode, and nothing after it in its own block ever actually runs.
 */
function printThrow(s: Extract<TStmt, { kind: "throw" }>): string {
	const args = s.args.length === 0 ? `${asciiString("")}` : s.args.map(print).join(", ");
	return `raise (${pascal(s.errorClass)}(${args}))`;
}

/** A statement with no control-flow meaning of its own: printed once, never re-entered. */
function printSimpleStmt(s: TStmt, depth: number): string {
	const p = pad(depth);
	switch (s.kind) {
		case "let":
			return `${p}let ${s.mutable ? "mutable " : ""}${s.name} = ${print(s.init)}`;
		case "multiLet":
			// Not produced for this target (`errorsAsValues: false`), kept for exhaustiveness.
			return `${p}let ${s.names.join(", ")} = ${print(s.init)}`;
		case "assign":
			return `${p}${print(s.target)} <- ${print(s.value)}`;
		case "expr":
			return `${p}${print(s.expr)} |> ignore`;
		case "raw":
			return `${p}${s.text}`;
		case "throw":
			return `${p}${printThrow(s)}`;
		default:
			throw new Error(`printSimpleStmt: unexpected statement kind ${s.kind}`);
	}
}

/* -- Loop-local sentinel names, unique within one function -------- */

let sentinelCounter = 0;
function freshSentinel(prefix: string): string {
	sentinelCounter += 1;
	return `__${prefix}${sentinelCounter}`;
}

type GuardCtx = {
	/** Set once a function has decided to use `__result`/`__returned`; unset in CPS-only mode. */
	readonly returnFlag?: string;
	/** The innermost loop's own sentinels, when that loop needs one. */
	readonly loop?: { readonly brk: string; readonly cont: string };
};

function guardExpr(ctx: GuardCtx): string | undefined {
	const parts: string[] = [];
	if (ctx.returnFlag !== undefined) parts.push(`not ${ctx.returnFlag}`);
	if (ctx.loop !== undefined) parts.push(`not ${ctx.loop.brk}`, `not ${ctx.loop.cont}`);
	return parts.length === 0 ? undefined : parts.join(" && ");
}

/** True when `s` could set one of the sentinels `ctx` is currently tracking. */
function isRisky(s: TStmt, ctx: GuardCtx): boolean {
	if (ctx.returnFlag !== undefined && containsReturn([s])) return true;
	if (ctx.loop !== undefined && hasLoopSignal([s], true)) return true;
	return false;
}

/**
 * Prints a statement list as ordinary F# statements (unit-typed, sequenced top to bottom), used
 * inside a loop body and, once a function needs `__returned`, for the whole function body. Only
 * the statements *after* the first one that could set an active sentinel are wrapped in one
 * `if <guard> then …` — everything before it runs unconditionally, since nothing could have set
 * the sentinel yet.
 */
function printGuardedBlock(stmts: readonly TStmt[], depth: number, ctx: GuardCtx): string {
	const lines: string[] = [];
	for (let i = 0; i < stmts.length; i++) {
		const s = stmts[i]!;
		lines.push(printGuardedStmt(s, depth, ctx));
		if (isRisky(s, ctx)) {
			const remainder = stmts.slice(i + 1);
			if (remainder.length > 0) {
				const g = guardExpr(ctx);
				if (g !== undefined) {
					lines.push(`${pad(depth)}if ${g} then`);
					lines.push(printGuardedBlock(remainder, depth + 1, ctx));
				} else {
					lines.push(printGuardedBlock(remainder, depth, ctx));
				}
			}
			return lines.join("\n");
		}
	}
	if (lines.length === 0) return `${pad(depth)}()`;
	return lines.join("\n");
}

function printGuardedStmt(s: TStmt, depth: number, ctx: GuardCtx): string {
	const p = pad(depth);
	switch (s.kind) {
		case "return": {
			if (ctx.returnFlag === undefined) throw new Error("printGuardedStmt: return outside flag mode");
			const value = s.value === undefined ? [] : [`${p}__result <- ${print(s.value)}`];
			return [...value, `${p}${ctx.returnFlag} <- true`].join("\n");
		}
		case "break":
			if (ctx.loop === undefined) throw new Error("printGuardedStmt: break outside a loop");
			return `${p}${ctx.loop.brk} <- true`;
		case "continue":
			if (ctx.loop === undefined) throw new Error("printGuardedStmt: continue outside a loop");
			return `${p}${ctx.loop.cont} <- true`;
		case "if": {
			const thenText = printGuardedBlock(s.then, depth + 1, ctx);
			if (s.otherwise.length === 0) return `${p}if ${print(s.test)} then\n${thenText}`;
			const elseText = printGuardedBlock(s.otherwise, depth + 1, ctx);
			return `${p}if ${print(s.test)} then\n${thenText}\n${p}else\n${elseText}`;
		}
		case "switch": {
			const cases = s.cases.map((c) => `${p}| ${valuePattern(c.values)} ->\n${printGuardedBlock(dropCaseCloser(c.body), depth + 1, ctx)}`);
			const fallback = s.otherwise !== undefined ? printGuardedBlock(dropCaseCloser(s.otherwise), depth + 1, ctx) : `${pad(depth + 1)}()`;
			return `${p}match ${print(s.subject)} with\n${cases.join("\n")}\n${p}| _ ->\n${fallback}`;
		}
		case "for":
		case "forEach":
			return printLoop(s, depth, ctx.returnFlag);
		default:
			return printSimpleStmt(s, depth);
	}
}

/** Prints one `for`/`forEach`, allocating its own `brk`/`cont` sentinels only if it needs them. */
function printLoop(s: Extract<TStmt, { kind: "for" }> | Extract<TStmt, { kind: "forEach" }>, depth: number, returnFlag: string | undefined): string {
	const needsSignal = hasLoopSignal(s.body, true);
	const p = pad(depth);
	const header =
		s.kind === "for"
			? (() => {
					const bound = s.inclusive ? print(s.to) : `(${print(s.to)} - ${s.step}L)`;
					const range = s.step === 1n ? `${print(s.from)} .. ${bound}` : `${print(s.from)} .. ${s.step}L .. ${bound}`;
					return `for ${s.name} in ${range} do`;
				})()
			: `for ${s.name} in ${print(s.iterable)} do`;
	const brk = needsSignal ? freshSentinel("brk") : undefined;
	const cont = needsSignal ? freshSentinel("cont") : undefined;
	const innerCtx: GuardCtx = { returnFlag, loop: brk !== undefined && cont !== undefined ? { brk, cont } : undefined };
	// The per-*iteration* gate: `printGuardedBlock` only wraps a body's statements *after* the
	// first one that could set a sentinel — right for one straight-line block, but a loop runs this
	// same body many times, and the returned/broken state a previous iteration left behind has to
	// stop every statement of the next one, including its very first, or a signal that fires on
	// iteration 3 would still let iteration 4 run in full (this is exactly the shape the loop
	// signal state exists to prevent — see `docs/targets/fsharp.md`). Whenever a return could reach
	// this loop, or this loop has its own `break`, every iteration is gated on it from the start.
	const gateParts: string[] = [];
	if (returnFlag !== undefined) gateParts.push(`not ${returnFlag}`);
	if (brk !== undefined) gateParts.push(`not ${brk}`);
	const gate = gateParts.length === 0 ? undefined : gateParts.join(" && ");
	const bodyDepth = gate === undefined ? depth + 1 : depth + 2;
	const bodyText = printGuardedBlock(s.body, bodyDepth, innerCtx);
	const lines: string[] = [];
	if (brk !== undefined) lines.push(`${p}let mutable ${brk} = false`);
	lines.push(`${p}${header}`);
	if (gate === undefined) {
		lines.push(bodyText);
	} else {
		lines.push(`${pad(depth + 1)}if ${gate} then`);
		if (cont !== undefined) lines.push(`${pad(depth + 2)}let mutable ${cont} = false`);
		lines.push(bodyText);
	}
	return lines.join("\n");
}

/* -- CPS: nested if/else expressions for a return that never crosses a loop -- */

/**
 * A continuation, parameterized by the depth it is spliced in at. `rest` (whatever follows an
 * `if`/`switch` this function is the tail of) is lowered once per branch that reaches it, and each
 * of those branches sits at a different nesting depth — capturing a single fixed depth at the
 * point a continuation is *built* would print its later lines at the depth of wherever it was
 * built, not the (deeper) depth of wherever it actually got embedded.
 */
type Cont = (depth: number) => string;

function lowerCps(stmts: readonly TStmt[], depth: number, tail: Cont): string {
	if (stmts.length === 0) return tail(depth);
	const head = stmts[0]!;
	const rest = stmts.slice(1);
	switch (head.kind) {
		case "return":
			return head.value === undefined ? "()" : print(head.value);
		case "if": {
			// An `if` that can never reach a `return` on either branch is an ordinary, unit-typed
			// statement (a guard that pushes to a list, say) — printing it as a two-way expression
			// would duplicate `rest` into both branches even though only one of them ever actually
			// runs before falling through to it. Only a genuine guard-clause `if` — one where some
			// path returns — gets the nested if/else expression treatment.
			if (!containsReturn(head.then) && !containsReturn(head.otherwise)) {
				const ifText = printGuardedStmt(head, depth, {});
				return `${ifText.trimStart()}\n${pad(depth)}${lowerCps(rest, depth, tail)}`;
			}
			const restTail: Cont = (d) => lowerCps(rest, d, tail);
			const thenText = lowerCps(head.then, depth + 1, restTail);
			const elseText = head.otherwise.length > 0 ? lowerCps(head.otherwise, depth + 1, restTail) : restTail(depth + 1);
			return `if ${print(head.test)} then\n${pad(depth + 1)}${thenText}\n${pad(depth)}else\n${pad(depth + 1)}${elseText}`;
		}
		case "switch": {
			const risky = head.cases.some((c) => containsReturn(dropCaseCloser(c.body))) || (head.otherwise !== undefined && containsReturn(dropCaseCloser(head.otherwise)));
			if (!risky) {
				const matchText = printSwitchStatement(head, depth);
				return `${matchText}\n${pad(depth)}${lowerCps(rest, depth, tail)}`;
			}
			const restTail: Cont = (d) => lowerCps(rest, d, tail);
			const cases = head.cases.map(
				(c) => `${pad(depth)}| ${valuePattern(c.values)} ->\n${pad(depth + 1)}${lowerCps(dropCaseCloser(c.body), depth + 1, restTail)}`,
			);
			const fallback = head.otherwise !== undefined ? lowerCps(dropCaseCloser(head.otherwise), depth + 1, restTail) : restTail(depth + 1);
			return `match ${print(head.subject)} with\n${cases.join("\n")}\n${pad(depth)}| _ ->\n${pad(depth + 1)}${fallback}`;
		}
		case "for":
		case "forEach": {
			const loopText = printLoop(head, depth, undefined);
			return `${loopText}\n${pad(depth)}${lowerCps(rest, depth, tail)}`;
		}
		default:
			return `${printSimpleStmt(head, depth).trimStart()}\n${pad(depth)}${lowerCps(rest, depth, tail)}`;
	}
}

/** A plain `match` statement (unit-typed), for a switch with no return in any of its cases. */
function printSwitchStatement(s: Extract<TStmt, { kind: "switch" }>, depth: number): string {
	const ctx: GuardCtx = {};
	const cases = s.cases.map((c) => `${pad(depth)}| ${valuePattern(c.values)} ->\n${printGuardedBlock(dropCaseCloser(c.body), depth + 1, ctx)}`);
	const fallback = s.otherwise !== undefined ? printGuardedBlock(dropCaseCloser(s.otherwise), depth + 1, ctx) : `${pad(depth + 1)}()`;
	return `${pad(depth)}match ${print(s.subject)} with\n${cases.join("\n")}\n${pad(depth)}| _ ->\n${fallback}`;
}

/**
 * Compiles a function or lambda body into the F# text of its value. This is the one place this
 * target chooses between the two renderings `docs/targets/fsharp.md` argues for: continuation-
 * passing nested `if`/`else` when no `return` inside this body is ever reached through a loop, or
 * a `__result`/`__returned` sentinel pair, uniformly, the moment one is.
 */
function compileBody(body: readonly TStmt[], retType: SemType | undefined): string {
	sentinelCounter = 0;
	if (!hasLoopWithReturn(body)) {
		return lowerCps(body, 0, () => `failwith "unreachable: every path is proven to return"`);
	}
	const ctx: GuardCtx = { returnFlag: "__returned" };
	const resultType = retType === undefined ? "" : ` : ${fsType(retType)}`;
	const lines = [
		`let mutable __result${resultType} = Unchecked.defaultof<_>`,
		`let mutable __returned = false`,
		printGuardedBlock(body, 0, ctx),
		`__result`,
	];
	return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Functions, records, modules
 * ------------------------------------------------------------------ */

export function printFunction(fn: TFunc): string {
	const params = fn.params.length === 0 ? "()" : fn.params.map((param) => `(${param.name}: ${fsType(param.type)})`).join(" ");
	const visibility = fn.moduleExported ? "" : "private ";
	const doc = fn.doc === undefined ? "" : `${fn.doc.split("\n").map((line) => `/// ${line}`.trimEnd()).join("\n")}\n`;
	const body = compileBody(fn.body, fn.ret);
	const indented = body
		.split("\n")
		.map((line) => (line === "" ? "" : `${INDENT}${line}`))
		.join("\n");
	return `${doc}let ${visibility}${fn.name} ${params} : ${fsType(fn.ret)} =\n${indented}`;
}

export function printRecord(record: TRecord): string {
	const doc = record.doc === undefined ? "" : `/// ${record.doc.split("\n")[0]}\n`;
	const fields = record.fields.map((field) => `${INDENT}${pascal(field.name)}: ${fsType(field.type)}`).join("\n");
	return `${doc}type ${pascal(record.name)} = {\n${fields}\n}`;
}

/**
 * F# requires every name a `let` binding uses to have been declared *earlier* in the same file —
 * there is no hoisting the way JavaScript's function declarations get, and Python only looks a
 * name up when a function is actually called, by which point the whole module has already run.
 * `generate()`'s own capability-entry-point split (`docs/decisions/0011-*.md`) always emits a
 * public wrapper *before* the seam it calls, which is exactly backwards here, so this module's
 * functions are topologically sorted by whether one's printed body text names another — the same
 * whole-word text search `driverFiles` already uses across modules, now within one.
 */
function topoSortFunctions(functions: readonly TFunc[]): readonly TFunc[] {
	const bodyText = new Map(functions.map((fn) => [fn.name, serializeForSearch(fn.body)]));
	const byName = new Map(functions.map((fn) => [fn.name, fn]));
	const ordered: TFunc[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (fn: TFunc): void => {
		if (visited.has(fn.name) || visiting.has(fn.name)) return;
		visiting.add(fn.name);
		const text = bodyText.get(fn.name)!;
		for (const other of functions) {
			if (other.name === fn.name) continue;
			if (new RegExp(`\\b${other.name}\\b`, "u").test(text)) {
				const dep = byName.get(other.name);
				if (dep !== undefined) visit(dep);
			}
		}
		visiting.delete(fn.name);
		visited.add(fn.name);
		ordered.push(fn);
	};
	for (const fn of functions) visit(fn);
	return ordered;
}

export function printModule(module: TModule): string {
	const parts = [
		module.header,
		"",
		`module Core.${fsModuleIdent(module.sourcePath)}`,
		"",
	];
	// `computeImports` (`backend/generate.ts`) only calls `supportImport` at all when it has a
	// non-empty `names` list to report — built for a target that selects individual names out of
	// its support file (Python's `from X import Y`), which `open` (a whole-module import with no
	// name list of its own) never has. `Core.Support` is added directly here instead, always, the
	// same "harmless when unused" reasoning `supportImport` above gives.
	const opens = [...new Set(module.imports.map((item) => item.from)), "Core.Support"].sort();
	for (const target of [...new Set(opens)]) parts.push(`open ${target}`);
	if (opens.length > 0) parts.push("");
	const body = [
		...module.records.map(printRecord),
		...module.constants.map((constant) => `let ${camel(constant.name)} : ${fsType(constant.type)} = ${print(constant.value)}`),
		...topoSortFunctions(module.functions).map(printFunction),
	];
	const printed = body.join("\n\n");
	const hoisted = hoistPatterns(module, printed);
	parts.push([...hoisted.declarations, hoisted.body].filter((section) => section !== "").join("\n\n"));
	return `${parts.join("\n").trimEnd()}\n`;
}

/** A module path as an F# identifier prefix, for hoisted pattern names: `is-valid-cpf` -> `IsValidCpf`. */
function identifierPrefix(sourcePath: string): string {
	return fsModuleIdent(sourcePath);
}

/**
 * Lifts every inline `Regex(...)` construction out of function bodies into a module-level `let`,
 * compiled once at load time instead of on every call — `Regex.IsMatch` with a string pattern has
 * no compilation cache, the same defect Go's `regexp.MustCompile` hoisting exists to avoid
 * (`docs/adding-a-target.md`).
 */
function hoistPatterns(module: TModule, body: string): { body: string; declarations: string[] } {
	const names = new Map<string, string>();
	const prefix = identifierPrefix(module.sourcePath);
	const hoisted = body.replaceAll(
		/System\.Text\.RegularExpressions\.Regex\.IsMatch\(([^,]+), ("(?:[^"\\]|\\.)*")\)/gu,
		(_match, value: string, literalPattern: string) => {
			const existing = names.get(literalPattern);
			const name = existing ?? `${prefix}Pattern${names.size + 1}`;
			if (existing === undefined) names.set(literalPattern, name);
			return `${name}.IsMatch(${value})`;
		},
	);
	const declarations = [...names].map(
		([literalPattern, name]) => `let private ${name} = System.Text.RegularExpressions.Regex(${literalPattern})`,
	);
	return { body: hoisted, declarations };
}

function importPath(_from: string, to: string): string {
	return `Core.${fsModuleIdent(to)}`;
}

/* ------------------------------------------------------------------ *
 * Support, errors, driver
 * ------------------------------------------------------------------ */

function supportModule(_program: CProgram, needs: SupportNeeds): { path: string; text: string } {
	const parts = [
		"// Code generated by the logic engine. DO NOT EDIT.",
		`// engine: ${ENGINE_VERSION}`,
		"// source: support",
		"",
		"module Core.Support",
		"",
		"/// The value at `index`, or `None` past the end — `ResizeArray`'s own indexer throws instead.",
		"let at (values: ResizeArray<'T>) (index: int64) : 'T option =",
		"    if index >= 0L && index < int64 values.Count then Some values.[int index] else None",
		"",
		"let compareInts (left: int64) (right: int64) : int64 =",
		"    if left < right then -1L elif left > right then 1L else 0L",
		"",
		"let compareOrdinal (left: string) (right: string) : int64 =",
		"    let c = System.String.CompareOrdinal(left, right)",
		"    if c < 0 then -1L elif c > 0 then 1L else 0L",
		"",
		"/// Scalar-counted, single-character-pad left padding — the pad argument is always one",
		"/// character at every call site this engine generates, the same assumption Go's own",
		"/// `padStart` support helper makes.",
		"let padStart (value: string) (length: int64) (pad: string) : string =",
		"    let scalarCount = int64 (Seq.length (value.EnumerateRunes()))",
		"    if scalarCount >= length then",
		"        value",
		"    else",
		"        let mutable prefix = \"\"",
		"        for _ in 1L .. (length - scalarCount) do",
		"            prefix <- prefix + pad",
		"        prefix + value",
		"",
		"let fromCodePoints (points: ResizeArray<int64>) : string =",
		"    let sb = System.Text.StringBuilder()",
		"    for point in points do",
		"        sb.Append(System.Text.Rune(int point)) |> ignore",
		"    sb.ToString()",
		"",
		"let parseDigits (value: string) : int64 option =",
		"    if value <> \"\" && value.Length <= 18 && value |> Seq.forall (fun c -> c >= '0' && c <= '9') then",
		"        Some (int64 value)",
		"    else",
		"        None",
		"",
		"let sortedStable (values: ResizeArray<'T>) (compare: 'T -> 'T -> int64) : ResizeArray<'T> =",
		"    ResizeArray(values |> Seq.sortWith (fun a b -> int (compare a b)))",
		"",
	];
	if (needs.race) {
		parts.push(
			"/// Runs idempotent tasks concurrently and answers the first one that answers `Some`.",
			"/// Cancellation is best effort: a losing task may run to completion, and its answer is",
			"/// dropped — the same trade Go's goroutine-and-channel `raceFirstSome` makes.",
			"let raceFirstSome (tasks: ResizeArray<unit -> 'T option>) : 'T option =",
			"    let running = tasks |> Seq.map (fun run -> System.Threading.Tasks.Task.Run(run)) |> Array.ofSeq",
			"    let pending = System.Collections.Generic.List<System.Threading.Tasks.Task<'T option>>(running)",
			"    let mutable answer = None",
			"    while answer.IsNone && pending.Count > 0 do",
			"        let index = System.Threading.Tasks.Task.WaitAny(pending |> Seq.cast<System.Threading.Tasks.Task> |> Array.ofSeq)",
			"        let finished = pending.[index]",
			"        pending.RemoveAt(index)",
			"        match finished.Result with",
			"        | Some value -> answer <- Some value",
			"        | None -> ()",
			"    answer",
			"",
		);
	}
	if (needs.env) {
		parts.push(
			"/// One request or response header.",
			"type HttpHeader = { Name: string; Value: string }",
			"",
			"/// A request handed to the environment.",
			"type HttpRequest = {",
			"    Method: string",
			"    Url: string",
			"    Headers: ResizeArray<HttpHeader>",
			"    Body: string",
			"    TimeoutMillis: int64",
			"}",
			"",
			"/// A response from the environment.",
			"type HttpResponse = { Status: int64; Headers: ResizeArray<HttpHeader>; Body: string }",
			"",
			"/// Everything the core needs from the outside world.",
			"type Capabilities =",
			"    abstract member Request: HttpRequest -> HttpResponse option",
			"    abstract member Now: unit -> int64",
			"    abstract member Sleep: int64 -> unit",
			"    abstract member NextU32: unit -> int64",
			"",
			"/// The platform default, built from `System.Net.Http.HttpClient` and the system clock and",
			"/// RNG. Built once, at module load, and shared by every public wrapper — never rebuilt per",
			"/// call — the same discipline Python's `DEFAULT_CAPABILITIES` and TypeScript's follow.",
			"type DefaultCapabilities() =",
			"    static let client = new System.Net.Http.HttpClient()",
			"    interface Capabilities with",
			"        member _.Request(request: HttpRequest) : HttpResponse option =",
			"            try",
			"                use message = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod(request.Method), request.Url)",
			"                if request.Body <> \"\" then",
			"                    message.Content <- new System.Net.Http.StringContent(request.Body)",
			"                for header in request.Headers do",
			"                    message.Headers.TryAddWithoutValidation(header.Name, header.Value) |> ignore",
			"                use cts = new System.Threading.CancellationTokenSource(System.TimeSpan.FromMilliseconds(float request.TimeoutMillis))",
			"                let response = client.Send(message, cts.Token)",
			"                use reader = new System.IO.StreamReader(response.Content.ReadAsStream())",
			"                let body = reader.ReadToEnd()",
			"                Some { Status = int64 (int response.StatusCode); Headers = ResizeArray(); Body = body }",
			"            with _ ->",
			"                None",
			"        member _.Now() : int64 = System.DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()",
			"        member _.Sleep(milliseconds: int64) : unit = System.Threading.Thread.Sleep(int milliseconds)",
			"        member _.NextU32() : int64 =",
			"            let bytes = System.Security.Cryptography.RandomNumberGenerator.GetBytes(4)",
			"            int64 (System.BitConverter.ToUInt32(bytes, 0))",
			"",
			"let defaultCapabilities : Capabilities = DefaultCapabilities() :> Capabilities",
			"",
		);
	}
	return { path: "Support.fs", text: parts.join("\n") };
}

function errorsModule(program: CProgram): { path: string; text: string } | undefined {
	const declared = [...program.errors.values()];
	if (declared.length === 0) return undefined;
	const lines = [
		"// Code generated by the logic engine. DO NOT EDIT.",
		`// engine: ${ENGINE_VERSION}`,
		"// source: errors",
		"",
		"module Core.Errors",
		"",
		"/// The root of every domain error the core raises.",
		"type DomainError(message: string) =",
		"    inherit System.Exception(message)",
		"",
	];
	for (const error of declared) {
		const base = error.base === undefined ? "DomainError" : pascal(error.base);
		if (error.doc !== undefined) lines.push(`/// ${error.doc.split("\n")[0]}`);
		lines.push(`type ${pascal(error.name)}(message: string) =`, `    inherit ${base}(message)`, "");
	}
	return { path: "Errors.fs", text: lines.join("\n") };
}

/** The generated differential driver, plus the project files that make the output buildable. */
/** A value's JSON-ish serialization, deep enough to text-search for a name reference in it. */
function serializeForSearch(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
}

function driverFiles(program: CProgram, entries: readonly DriverEntry[], modules: readonly TModule[]): { path: string; text: string }[] {
	// A topological order of the modules this run actually generated, so `Core.fsproj`'s
	// `<Compile>` list puts every callee's file before its caller's — F# requires that, unlike Go's
	// single order-independent package. `modules` (not `CProgram.functions[].calls`, which only
	// knows about ordinary Core-level calls) is the one place that also knows about a *portable*
	// lowering's dependency on a stdlib module: that connection is made during lowering, by a
	// candidate's own `sourceFn`, and it shows up here as the stdlib function's *name* appearing in
	// the caller's printed body — inside a `call` node for an ordinary cross-module call, or inside
	// a `raw` node's text for a portable one — which is exactly what a whole-word text search over
	// each function's serialized body finds, regardless of which of the two shapes it came from.
	const declaredIn = new Map<string, string>();
	for (const module of modules) {
		for (const fn of module.functions) declaredIn.set(fn.name, module.sourcePath);
		for (const record of module.records) declaredIn.set(record.name, module.sourcePath);
	}
	const bodyTextOf = new Map<string, string>();
	for (const module of modules) {
		bodyTextOf.set(
			module.sourcePath,
			serializeForSearch({ functions: module.functions.map((fn) => fn.body), constants: module.constants.map((c) => c.value) }),
		);
	}
	const edges = new Map<string, Set<string>>();
	for (const module of modules) edges.set(module.sourcePath, new Set());
	for (const module of modules) {
		const text = bodyTextOf.get(module.sourcePath)!;
		for (const [name, owner] of declaredIn) {
			if (owner === module.sourcePath) continue;
			if (new RegExp(`\\b${name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u").test(text)) {
				edges.get(module.sourcePath)!.add(owner);
			}
		}
	}
	const pathOf = new Map(modules.map((module) => [module.sourcePath, module.path]));
	const orderedModules: string[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (name: string): void => {
		if (visited.has(name) || !edges.has(name)) return;
		if (visiting.has(name)) return; // no cycles in a call graph the checker already accepted
		visiting.add(name);
		for (const dep of [...edges.get(name)!].sort()) visit(dep);
		visiting.delete(name);
		visited.add(name);
		orderedModules.push(name);
	};
	for (const module of [...modules].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))) visit(module.sourcePath);

	const hasErrors = program.errors.size > 0;
	const usesEnv = entries.some((entry) => entry.usesEnv);
	const compileFiles = [...(hasErrors ? ["Errors.fs"] : []), "Support.fs", ...orderedModules.map((name) => pathOf.get(name)!)];

	const decode = (type: SemType, expr: string): string => {
		switch (type.kind) {
			case "Bool":
				return `(${expr} :?> bool)`;
			case "Int":
			case "Decimal":
			case "CivilDate":
			case "Instant":
			case "Duration":
				return `(int64 (${expr} :?> float))`;
			case "Float":
				return `(${expr} :?> float)`;
			case "String":
			case "Enum":
				return `(${expr} :?> string)`;
			case "Option":
				return `(if ${expr} = null then None else Some ${decode(type.inner, expr)})`;
			case "List": {
				const elemType = fsType(type.elem);
				return `(ResizeArray((${expr} :?> System.Collections.Generic.List<obj>) |> Seq.map (fun __item -> ${decode(type.elem, "__item")})) : ResizeArray<${elemType}>)`;
			}
			case "Record": {
				const definition = program.records.get(type.name);
				const fields = (definition?.fields ?? []).map((field) => {
					const access = `((${expr} :?> System.Collections.Generic.Dictionary<string, obj>).[${JSON.stringify(field.name)}])`;
					return `${pascal(field.name)} = ${decode(field.type, access)}`;
				});
				return `{ ${fields.join("; ")} }`;
			}
			default:
				return expr;
		}
	};

	const encode = (type: SemType, expr: string): string => {
		switch (type.kind) {
			case "Int":
			case "Decimal":
			case "CivilDate":
			case "Instant":
			case "Duration":
				return `(box (float ${expr}))`;
			case "Option":
				return `(match ${expr} with Some __v -> ${encode(type.inner, "__v")} | None -> null)`;
			case "List":
				return `(box (${expr} |> Seq.map (fun __item -> ${encode(type.elem, "__item")}) |> Array.ofSeq))`;
			case "Record": {
				const definition = program.records.get(type.name);
				const fields = (definition?.fields ?? [])
					.map((field) => `(${JSON.stringify(field.name)}, ${encode(field.type, `${expr}.${pascal(field.name)}`)})`)
					.join("; ");
				return `(box (dict [ ${fields} ]))`;
			}
			default:
				return `(box ${expr})`;
		}
	};

	const moduleIdentOfPath = new Map(modules.map((module) => [module.path, fsModuleIdent(module.sourcePath)]));
	const cases = entries.map((entry) => {
		const args = [
			...entry.params.map((param, index) => decode(param, `args.[${index}]`)),
			...(entry.usesEnv ? ["environment"] : []),
		];
		const call = `Core.${moduleIdentOfPath.get(entry.modulePath)!}.${entry.targetName} ${args.map((a) => `(${a})`).join(" ")}`;
		// Bound once, to a plain name: `encode` reads a Record's fields off its argument text once
		// per field, so handing it the call expression directly would call the function again for
		// every field (network effects included) instead of reading fields off one shared answer —
		// and `box` needs its whole argument already parenthesized as one applied call, not `box f x`
		// (parsed as `(box f) x`, since `box` is itself a plain curried function here).
		const bound = `let __answer = (${call}) in ${encode(entry.ret, "__answer")}`;
		const body =
			entry.fails.length > 0
				? [
						`        try`,
						`            Ok (${bound})`,
						`        with`,
						...entry.fails.map((name) => `        | :? Core.Errors.${pascal(name)} -> Error (errorName typeof<Core.Errors.${pascal(name)}>)`),
						`        | ex -> Error (ex.GetType().Name)`,
					].join("\n")
				: `        Ok (${bound})`;
		return `    | ${JSON.stringify(entry.coreName)} ->\n${body}`;
	});

	const main = [
		"// Code generated by the logic engine. DO NOT EDIT.",
		"// source: _driver",
		"",
		"module Driver.Program",
		"",
		"open System",
		"open System.Text.Json",
		"",
		"let errorName (t: System.Type) : string = t.Name",
		"",
		...(usesEnv
			? [
					"// The reference PCG32: same constants and default seed as the interpreter's, so a draw",
					"// matches the reference bit for bit. A fresh instance is built for every request, the",
					"// same way the reference model starts a fresh interpreter, and so a fresh generator, per",
					"// case.",
					"type Pcg32(seed: uint64) =",
					"    let increment = 1442695040888963407UL",
					"    let mutable state = 0UL",
					"    let step () : int64 =",
					"        let previous = state",
					"        state <- previous * 6364136223846793005UL + increment",
					"        let xorshifted = uint32 (((previous >>> 18) ^^^ previous) >>> 27)",
					"        let rotation = uint32 (previous >>> 59)",
					"        int64 ((xorshifted >>> int rotation) ||| (xorshifted <<< int ((-int rotation) &&& 31)))",
					"    do",
					"        step () |> ignore",
					"        state <- state + seed",
					"        step () |> ignore",
					"    member _.NextU32() : int64 = step ()",
					"",
					"let defaultSeed = 0x853c49e6748fea9bUL",
					"",
					"type Fixture = { Status: int64; Body: string; LatencyMillis: int64 }",
					"",
					"type FakeCapabilities(fixtures: System.Collections.Generic.Dictionary<string, Fixture>) =",
					"    let random = Pcg32(defaultSeed)",
					"    interface Core.Support.Capabilities with",
					"        member _.Request(request: Core.Support.HttpRequest) : Core.Support.HttpResponse option =",
					"            match fixtures.TryGetValue(request.Url) with",
					"            | false, _ -> None",
					"            | true, fixture ->",
					"                System.Threading.Thread.Sleep(int fixture.LatencyMillis)",
					"                Some { Status = fixture.Status; Headers = ResizeArray(); Body = fixture.Body }",
					"        member _.Now() : int64 = 0L",
					"        member _.Sleep(milliseconds: int64) : unit = System.Threading.Thread.Sleep(int milliseconds)",
					"        member _.NextU32() : int64 = random.NextU32()",
					"",
					// Relative to the process's current directory, like every other target's driver reads
				// it — not `AppContext.BaseDirectory` (the build output directory), which `dotnet run`
				// never changes to: the conformance harness's own working directory is this target's
				// output directory, exactly where it writes `fixtures.json`.
				"let fixturesPath = \"fixtures.json\"",
					"",
					"let loadFixtures () : System.Collections.Generic.Dictionary<string, Fixture> =",
					"    if System.IO.File.Exists(fixturesPath) then",
					"        let raw = System.IO.File.ReadAllText(fixturesPath)",
					"        let parsed = JsonDocument.Parse(raw)",
					"        let out = System.Collections.Generic.Dictionary<string, Fixture>()",
					"        for prop in parsed.RootElement.EnumerateObject() do",
					"            let status = prop.Value.GetProperty(\"status\").GetInt64()",
					"            let body = prop.Value.GetProperty(\"body\").GetString()",
					"            let latency =",
					"                match prop.Value.TryGetProperty(\"latencyMillis\") with",
					"                | true, v -> v.GetInt64()",
					"                | false, _ -> 0L",
					"            out.[prop.Name] <- { Status = status; Body = body; LatencyMillis = latency }",
					"        out",
					"    else",
					"        System.Collections.Generic.Dictionary<string, Fixture>()",
					"",
					"let fixtures = loadFixtures ()",
					"",
					"let newEnvironment () : Core.Support.Capabilities = FakeCapabilities(fixtures) :> Core.Support.Capabilities",
					"",
				]
			: []),
		"/// Decodes one JSON element into the plain `obj` tree the decoders above pattern-match on.",
		"let rec fromJson (element: JsonElement) : obj =",
		"    match element.ValueKind with",
		"    | JsonValueKind.Null -> null",
		"    | JsonValueKind.True -> box true",
		"    | JsonValueKind.False -> box false",
		"    | JsonValueKind.Number -> box (element.GetDouble())",
		"    | JsonValueKind.String -> box (element.GetString())",
		"    | JsonValueKind.Array ->",
		"        let items = System.Collections.Generic.List<obj>()",
		"        for item in element.EnumerateArray() do",
		"            items.Add(fromJson item)",
		"        box items",
		"    | JsonValueKind.Object ->",
		"        let fields = System.Collections.Generic.Dictionary<string, obj>()",
		"        for prop in element.EnumerateObject() do",
		"            fields.[prop.Name] <- fromJson prop.Value",
		"        box fields",
		"    | _ -> null",
		"",
		"let rec toJsonNode (value: obj) : System.Text.Json.Nodes.JsonNode =",
		"    match value with",
		"    | null -> null",
		"    | :? bool as b -> System.Text.Json.Nodes.JsonValue.Create(b) :> _",
		"    | :? float as f -> System.Text.Json.Nodes.JsonValue.Create(f) :> _",
		"    | :? string as s -> System.Text.Json.Nodes.JsonValue.Create(s) :> _",
		"    | :? (obj[]) as items ->",
		"        let node = System.Text.Json.Nodes.JsonArray()",
		"        for item in items do node.Add(toJsonNode item)",
		"        node :> _",
		// `dict […]` — what `encode` builds a record into, below — answers an internal read-only
		// wrapper that implements the *generic* `IDictionary<string, obj>` only, not the
		// non-generic `System.Collections.IDictionary` a `Dictionary<_,_>` also satisfies; matching
		// the generic interface recognizes both origins with the one pattern.
		"    | :? System.Collections.Generic.IDictionary<string, obj> as fields ->",
		"        let node = System.Text.Json.Nodes.JsonObject()",
		"        for key in fields.Keys do",
		"            node.[key] <- toJsonNode (fields.[key])",
		"        node :> _",
		"    | _ -> null",
		"",
		"let dispatch (name: string) (args: obj[])" + (usesEnv ? " (environment: Core.Support.Capabilities)" : "") + " : Result<obj, string> =",
		"    match name with",
		...cases,
		"    | _ -> Error (sprintf \"unknown function %s\" name)",
		"",
		"[<EntryPoint>]",
		"let main _argv =",
		"    let mutable line = System.Console.In.ReadLine()",
		"    while line <> null do",
		"        if line.Trim() <> \"\" then",
		"            let parsed = JsonDocument.Parse(line).RootElement",
		"            let fn = parsed.GetProperty(\"fn\").GetString()",
		"            let args = parsed.GetProperty(\"args\").EnumerateArray() |> Seq.map fromJson |> Array.ofSeq",
		...(usesEnv
			? [
					"            // A fresh environment per line: NextU32 starts from the same state the",
					"            // reference model's fresh interpreter starts from for every case.",
					"            let environment = newEnvironment ()",
					"            let outcome = dispatch fn args environment",
				]
			: ["            let outcome = dispatch fn args"]),
		"            let out = System.Text.Json.Nodes.JsonObject()",
		"            match outcome with",
		"            | Ok value ->",
		"                out.[\"ok\"] <- System.Text.Json.Nodes.JsonValue.Create(true)",
		"                out.[\"value\"] <- toJsonNode value",
		"            | Error message ->",
		"                out.[\"ok\"] <- System.Text.Json.Nodes.JsonValue.Create(false)",
		"                out.[\"error\"] <- System.Text.Json.Nodes.JsonValue.Create(message)",
		"            System.Console.Out.WriteLine(out.ToJsonString())",
		"        line <- System.Console.In.ReadLine()",
		"    0",
		"",
	].join("\n");

	const coreFsproj = [
		'<Project Sdk="Microsoft.NET.Sdk">',
		"",
		"  <PropertyGroup>",
		"    <TargetFramework>net8.0</TargetFramework>",
		"    <WarningsAsErrors>true</WarningsAsErrors>",
		"    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
		"    <Nullable>enable</Nullable>",
		"  </PropertyGroup>",
		"",
		"  <ItemGroup>",
		...compileFiles.map((file) => `    <Compile Include="${file}" />`),
		"  </ItemGroup>",
		"",
		"</Project>",
		"",
	].join("\n");

	const driverFsproj = [
		'<Project Sdk="Microsoft.NET.Sdk">',
		"",
		"  <PropertyGroup>",
		"    <OutputType>Exe</OutputType>",
		"    <TargetFramework>net8.0</TargetFramework>",
		"    <WarningsAsErrors>true</WarningsAsErrors>",
		"    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
		"    <InvariantGlobalization>true</InvariantGlobalization>",
		"  </PropertyGroup>",
		"",
		"  <ItemGroup>",
		'    <Compile Include="Program.fs" />',
		"  </ItemGroup>",
		"",
		"  <ItemGroup>",
		'    <ProjectReference Include="../Core.fsproj" />',
		"  </ItemGroup>",
		"",
		"</Project>",
		"",
	].join("\n");

	return [
		{ path: "Core.fsproj", text: coreFsproj },
		{ path: "Driver/Program.fs", text: main },
		{ path: "Driver/Driver.fsproj", text: driverFsproj },
	];
}

export const FSHARP_BACKEND: Backend = {
	spec: FSHARP_SPEC,
	fileExtension: FSHARP_CONFIG.fileExtension,
	printModule,
	importPath,
	support: supportModule,
	errorsModule,
	renderType: fsType,
	comment: "//",
	driver: driverFiles,
	// `open`, unlike a selective import, names no particular symbol, so there is nothing to gate on
	// `needs`/`usesEnv`/`builtins`: every module opens `Core.Support` unconditionally, the same way
	// it would open any module whose helpers it might reach for. An unused `open` is not a warning
	// F#'s compiler raises, so this costs nothing when a module happens not to need one.
	supportImport: () => [{ from: "Core.Support", names: [] }],
	defaultCapabilities: {
		ref: { kind: "raw", text: "Core.Support.defaultCapabilities" },
		imports: [{ from: "Core.Support", names: [] }],
		seamName: (publicName) => `${publicName}With`,
	},
};
