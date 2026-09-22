/**
 * The Erlang backend.
 *
 * Erlang/OTP 25, standard library only. This is the one target whose language has no loop
 * construct and no mutable variable at all: `let mut`, `assign`, `forRange`, `forEach`, `break`
 * and `continue` all have to survive translation into single-assignment bindings and recursive
 * functions. `docs/targets/erlang.md` works out that translation before any of this file was
 * written; the short version is:
 *
 * - every mutable local becomes a fresh Erlang variable on each reassignment (SSA by
 *   construction — `bind`/`resolveName` below);
 * - `forRange`/`forEach` become a self-recursive named `fun` (`Loop = fun Loop(...) -> ... end`)
 *   whose parameters are exactly the outer-scope locals the loop body reassigns ("carried"
 *   variables) plus the induction variable; everything else the loop body reads is closed over,
 *   because Erlang funs are real closures;
 * - whatever statement sequence follows a loop, an `if` or a `switch` is not left for the call
 *   site to stitch back on: it is compiled *into* every point control can still fall through to
 *   normal completion (the loop's exhausted clause, every `break`, the non-terminal arm of an
 *   `if`/`switch`). A `return`/`throw`/`fail` never needs that treatment: its value is simply the
 *   value of whatever nested `case` it sits inside, which is already the correct value of every
 *   enclosing expression once Erlang's own call stack unwinds — no continuation-passing, no
 *   tagged control-flow values, ever. This is the "REST inlining" scheme `erlang.md` derives
 *   before this printer implements it, and it is the thing that makes `break` plus an accumulator
 *   ("cpfCheckDigit") and an early `return` from inside a loop ("isRepeatedRun") both come out as
 *   ordinary, idiomatic recursive Erlang.
 *
 * Every generated variable name is minted from a single monotonic counter per function
 * (`bind`/`Ctx.versions`), never reused across branches, so no two bindings anywhere in one
 * function's body can ever produce Erlang's "variable shadowed" warning — the project runs
 * `erlc +warn_unused_vars +warnings_as_errors`, so that would otherwise fail the build.
 *
 * Strings are UTF-8 binaries (`docs/targets/erlang.md` argues the choice); records are Erlang
 * maps, which need no per-module `-record`/`.hrl` declaration to share across module boundaries;
 * `Fail<E>` is `errorsAsValues`, exactly like Go, represented as `{Value, nil}` on success and
 * `{Zero, {ErrorTag, Message}}` on failure — the atom `nil` is deliberate, not a Go-ism: it is
 * what `backend/lower.ts`'s shared `hoistFallible` hard-codes as `raw("nil")` for every
 * `errorsAsValues` target, and `nil` written bare is already a valid, ordinary Erlang atom, so
 * that shared code needs no change at all to work here.
 */

import type { Backend, DriverEntry, SupportNeeds } from "../../backend/generate.ts";
import { ENGINE_VERSION } from "../../backend/generate.ts";
import type { TargetSpec } from "../../backend/lower.ts";
import type { Candidate } from "../../backend/select.ts";
import { LoweringTable, argIsAscii } from "../../backend/select.ts";
import type { TExpr, TFunc, TModule, TRecord, TStmt } from "../../backend/tast.ts";
import type { CProgram } from "../../core/ir.ts";
import { printRegex } from "../../regex.ts";
import { TRIM_CODE_POINTS } from "../../intrinsics/index.ts";
import type { SemType } from "../../types.ts";
import type { Value } from "../../values.ts";

export const ERLANG_CONFIG = {
	baseline: "Erlang/OTP 25",
	fileExtension: ".erl",
	dependencies: [] as string[],
	// No formatter exists for Erlang in this toolchain (no `rebar3`, no `erlfmt` installed) — see
	// `docs/targets/erlang.md`. The printer's own output is therefore the committed byte shape,
	// and it has to be stable on its own: fixed indentation, no trailing whitespace, one style.
	formatter: undefined as string | undefined,
	linters: ["erlc +warn_unused_vars +warnings_as_errors"],
};

/* ------------------------------------------------------------------ *
 * Naming
 * ------------------------------------------------------------------ */

/** `PascalCase`, which is what a legal Erlang variable name has to start with (an upper case letter). */
function pascal(name: string): string {
	const cleaned = name.replace(/[-_](.)/g, (_match, char: string) => char.toUpperCase());
	return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** `snake_case`, for atoms: function names, module names, map field keys and error tags. */
function snake(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replaceAll("-", "_")
		.toLowerCase();
}

/** A Core module path (which may contain `/` and `-`) as a legal, unquoted Erlang atom. */
function moduleAtom(path: string): string {
	return path.replace(/\.erl$/, "").replace(/[^a-zA-Z0-9]+/g, "_");
}

/* ------------------------------------------------------------------ *
 * Literal printing
 * ------------------------------------------------------------------ */

/**
 * A UTF-8 binary literal. Erlang's own escapes, not `tast.ts`'s `asciiString` (which speaks the
 * `\uXXXX` JavaScript/Python/Go/Rust dialect): a non-ASCII scalar is `\x{...}`, and the whole
 * literal carries `/utf8` so the escapes and every ordinary character encode as UTF-8 bytes
 * rather than one Latin-1 byte per scalar.
 */
function erlString(value: string): string {
	let out = '<<"';
	for (const scalar of value) {
		const point = scalar.codePointAt(0)!;
		if (scalar === '"') out += '\\"';
		else if (scalar === "\\") out += "\\\\";
		else if (point === 0x0a) out += "\\n";
		else if (point === 0x0d) out += "\\r";
		else if (point === 0x09) out += "\\t";
		else if (point < 0x20 || point === 0x7f || point > 0x7e) out += `\\x{${point.toString(16)}}`;
		else out += scalar;
	}
	return `${out}"/utf8>>`;
}

function literal(value: Value): string {
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "string") return erlString(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
	return "nil";
}

/* ------------------------------------------------------------------ *
 * Capability table
 * ------------------------------------------------------------------ */

const raw = (text: string): TExpr => ({ kind: "raw", text });
/**
 * A name fresh across the whole program, for the one candidate (`opt.orElse`) that has to bind a
 * variable inside a fragment it builds at lowering time — before this printer's own per-function
 * `bind` counter exists to hand it a properly SSA-scoped one instead. See that candidate's comment.
 */
let optTempCounter = 0;
function freshOptTemp(): string {
	optTempCounter += 1;
	return `__opt${optTempCounter}`;
}
const nameExpr = (name: string): TExpr => ({ kind: "name", name });
const callExpr = (name: string, args: readonly TExpr[]): TExpr => ({ kind: "call", callee: nameExpr(name), args });
const applyExpr = (fn: TExpr, args: readonly TExpr[]): TExpr => ({ kind: "call", callee: fn, args });
/** A placeholder `SemType`: this printer never reads a lambda parameter's declared type. */
const anyType: SemType = { kind: "Bool" };
/**
 * `lists:sort/2`'s comparator shape (`fun(A, B) -> boolean()`) from a three-way `(a, b) -> int`
 * comparator, the shape `seq.sortStable`'s own argument has.
 */
function threeWayComparator(compare: TExpr): TExpr {
	return {
		kind: "lambda",
		params: [{ name: "__a", type: anyType }, { name: "__b", type: anyType }],
		body: [
			{
				kind: "return",
				value: { kind: "binary", op: "<=", left: applyExpr(compare, [nameExpr("__a"), nameExpr("__b")]), right: { kind: "lit", value: 0n, type: anyType } },
			},
		],
		ret: anyType,
	};
}
/** `lists:sort/2`'s comparator shape from a key extractor, the shape `seq.sortStableBy` has. */
function keyComparator(key: TExpr): TExpr {
	return {
		kind: "lambda",
		params: [{ name: "__a", type: anyType }, { name: "__b", type: anyType }],
		body: [
			{
				kind: "return",
				value: { kind: "binary", op: "<=", left: applyExpr(key, [nameExpr("__a")]), right: applyExpr(key, [nameExpr("__b")]) },
			},
		],
		ret: anyType,
	};
}
/** The sentinel `seq.push` emits: `assign`'s printer recognizes this shape and does the SSA rename `lower.ts` cannot know to do (see the module doc, and `compileStmts`'s `"expr"` case). */
const PUSH_OP = "__erlang_push__";
const SET_INDEX_OP = "__erlang_set_index__";

/**
 * A stateless printer, used *only* inside a capability-table candidate's own `emit`, which runs
 * once during `lowerProgram` — before any SSA renaming exists, because renaming is a property of
 * *where in the statement sequence* a name is read, which `emit` cannot see (it sees only the
 * argument subtree). A candidate that embeds `print(args[0])` in a `raw` fragment therefore always
 * gets the *plain*, unversioned spelling `naming.value` produced (`"Sum"`, never `"Sum2"`); that
 * plain spelling is what `compileExpr`'s `"raw"` case below then rewrites, word by word, into
 * whatever SSA name is actually live at the point that fragment is finally printed — the same
 * technique the Python backend's `applyPrivacy` already uses on its own `raw` fragments for a
 * different rename. A structured node (`binary`, `call`, `list`, …) never needs this: its children
 * stay real `TExpr`s, which `compileExpr` walks and resolves itself.
 */
function print(expr: TExpr): string {
	switch (expr.kind) {
		case "lit":
			return literal(expr.value);
		case "name":
			return expr.name;
		case "raw":
			return expr.text;
		case "call": {
			const callee = expr.callee.kind === "name" ? expr.callee.name : `(${print(expr.callee)})`;
			return `${callee}(${expr.args.map(print).join(", ")})`;
		}
		case "method":
			return `${print(expr.target)}:${snake(expr.name)}(${expr.args.map(print).join(", ")})`;
		case "member":
			return `maps:get(${snake(expr.name)}, ${print(expr.target)})`;
		case "index":
			return `lists:nth((${print(expr.index)}) + 1, ${print(expr.target)})`;
		case "binary":
			return `(${print(expr.left)} ${erlOperator(expr.op)} ${print(expr.right)})`;
		case "unary":
			if (expr.op === "!" && expr.operand.kind === "binary" && expr.operand.op === "==") {
				return `(${print(expr.operand.left)} =/= ${print(expr.operand.right)})`;
			}
			return expr.op === "!" ? `(not ${print(expr.operand)})` : `(${expr.op}${print(expr.operand)})`;
		case "ternary":
			return `(case ${print(expr.test)} of true -> ${print(expr.then)}; false -> ${print(expr.otherwise)} end)`;
		case "list":
			return `[${expr.items.map(print).join(", ")}]`;
		case "record":
			return `#{${expr.fields.map((field) => `${snake(field.name)} => ${print(field.value)}`).join(", ")}}`;
		case "lambda": {
			const params = expr.params.map((param) => param.name);
			return `fun(${params.join(", ")}) ->\n${indent(expr.body.map((s) => printRawStmt(s)).join(",\n"))}\nend`;
		}
		case "none":
			return "none";
		case "zero":
			return "undefined";
		case "some":
			return `{some, ${print(expr.inner)}}`;
		default: {
			const exhaustive: never = expr;
			return exhaustive;
		}
	}
}

/**
 * A plain (non-SSA) statement printer, used only by `print`'s `"lambda"` case. No capability-table
 * candidate in this file ever hands a lambda-carrying argument to `raw`/`print` — a lambda always
 * reaches `compileExpr`'s own `"lambda"` case, which compiles its body properly (SSA, `break`,
 * `return`, all of it) — so this exists only so `print` stays total, not because it is reachable.
 */
function printRawStmt(stmt: TStmt): string {
	switch (stmt.kind) {
		case "return":
			return stmt.value === undefined ? "ok" : print(stmt.value);
		case "expr":
			return print(stmt.expr);
		default:
			return "ok";
	}
}

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

export const ERLANG_CANDIDATES: readonly Candidate[] = [
	...["add:+", "sub:-", "mul:*"].map((entry) => {
		const [op, symbol] = entry.split(":") as [string, string];
		return { op: `int.${op}`, impl: "native" as const, cost: cheap, emit: binary(symbol) };
	}),
	{
		op: "int.div",
		impl: "native",
		because: "Erlang's `div` truncates toward zero, which is the Core's rule",
		cost: cheap,
		emit: binary("div"),
	},
	{
		op: "int.mod",
		impl: "native",
		because: "Erlang's `rem` takes the sign of the dividend, which is the Core's rule",
		cost: cheap,
		emit: binary("rem"),
	},
	{ op: "int.neg", impl: "native", cost: cheap, emit: (args) => raw(`(-${print(args[0]!)})`) },
	{ op: "int.abs", impl: "native", cost: cheap, emit: (args) => raw(`abs(${print(args[0]!)})`) },
	{ op: "int.min", impl: "native", cost: cheap, emit: (args) => raw(`min(${print(args[0]!)}, ${print(args[1]!)})`) },
	{ op: "int.max", impl: "native", cost: cheap, emit: (args) => raw(`max(${print(args[0]!)}, ${print(args[1]!)})`) },
	{ op: "int.lt", impl: "native", cost: cheap, emit: binary("<") },
	{ op: "int.le", impl: "native", cost: cheap, emit: binary("=<") },
	{ op: "int.gt", impl: "native", cost: cheap, emit: binary(">") },
	{ op: "int.ge", impl: "native", cost: cheap, emit: binary(">=") },
	{ op: "core.eq", impl: "native", cost: cheap, emit: binary("=:=") },

	{ op: "opt.isNone", impl: "native", cost: cheap, emit: (args) => ({ kind: "binary", op: "=:=", left: args[0]!, right: raw("none") }) },
	{
		op: "opt.unwrap",
		impl: "native",
		// `{some, V}` is a 2-tuple, so its payload is `element(2, ...)` — no `case`, and so no bound
		// name at all, which sidesteps the "opt.orElse" note just below entirely.
		cost: cheap,
		emit: (args) => raw(`element(2, ${print(args[0]!)})`),
	},
	{ op: "opt.some", impl: "native", cost: cheap, emit: (args) => raw(`{some, ${print(args[0]!)}}`) },
	{
		op: "opt.orElse",
		impl: "native",
		// A fresh name *for every call site this candidate is ever selected at, across the whole
		// program*, not merely within one function: `emit` runs once per use, at lowering time, long
		// before this printer's own per-function `bind` counter exists to hand it one instead. It has
		// to be this fresh because `opt.orElse` nests (an option-returning call inside another
		// option's fallback), and two nested `case`s binding the identical name is exactly the
		// "variable already bound" `erlc` rejects.
		cost: cheap,
		emit: (args) => {
			const temp = freshOptTemp();
			return raw(`(case ${print(args[0]!)} of {some, ${temp}} -> ${temp}; none -> ${print(args[1]!)} end)`);
		},
	},

	{
		op: "str.len",
		impl: "native",
		requires: argIsAscii(0),
		because: "`byte_size` counts bytes, which equals the scalar count only for ASCII",
		cost: cheap,
		emit: (args) => raw(`byte_size(${print(args[0]!)})`),
	},
	{
		op: "str.len",
		impl: "library",
		because: "decoding to a code point list counts scalars exactly, at the cost of the decode",
		cost: allocating,
		emit: (args) => raw(`length(unicode:characters_to_list(${print(args[0]!)}, utf8))`),
	},
	// A binary segment's value has to be parenthesized whenever it is more than a bare variable or
	// literal (`t6.erl` in the session scratch confirmed `<<f(X)/binary>>` is a syntax error, and
	// `<<(f(X))/binary>>` is not) — `args[0]`/`args[1]` are frequently a nested call, so both always
	// get the parens rather than only when they turn out to need them.
	{ op: "str.concat", impl: "native", cost: allocating, emit: (args) => raw(`<<(${print(args[0]!)})/binary, (${print(args[1]!)})/binary>>`) },
	{
		op: "str.codeAt",
		impl: "native",
		requires: argIsAscii(0),
		because: "a byte of a UTF-8 binary is the scalar's own code point only for ASCII",
		cost: cheap,
		emit: (args) => raw(`binary:at(${print(args[0]!)}, ${print(args[1]!)})`),
	},
	{
		op: "str.charAt",
		impl: "native",
		requires: argIsAscii(0),
		cost: allocating,
		emit: (args) => raw(`binary:part(${print(args[0]!)}, ${print(args[1]!)}, 1)`),
	},
	{
		op: "str.codeAtOpt",
		impl: "library",
		requires: argIsAscii(0),
		cost: cheap,
		emit: (args) => raw(`erl_support:erl_code_at(${print(args[0]!)}, ${print(args[1]!)})`),
	},
	{
		op: "str.charAtOpt",
		impl: "library",
		requires: argIsAscii(0),
		cost: allocating,
		emit: (args) => raw(`erl_support:erl_char_at(${print(args[0]!)}, ${print(args[1]!)})`),
	},
	{
		op: "str.slice",
		impl: "native",
		requires: argIsAscii(0),
		because: "slicing cuts at byte boundaries",
		cost: cheap,
		emit: (args) => raw(`binary:part(${print(args[0]!)}, ${print(args[1]!)}, (${print(args[2]!)}) - (${print(args[1]!)}))`),
	},
	{
		op: "str.indexOf",
		impl: "library",
		because: "`binary:match` returns a byte offset",
		cost: linear,
		emit: (args) => raw(`erl_support:erl_index_of(${print(args[0]!)}, ${print(args[1]!)})`),
	},
	{
		op: "str.contains",
		impl: "library",
		cost: linear,
		emit: (args) => raw(`(binary:match(${print(args[0]!)}, ${print(args[1]!)}) =/= nomatch)`),
	},
	{ op: "str.startsWith", impl: "library", cost: linear, emit: (args) => raw(`erl_support:erl_starts_with(${print(args[0]!)}, ${print(args[1]!)})`) },
	{ op: "str.endsWith", impl: "library", cost: linear, emit: (args) => raw(`erl_support:erl_ends_with(${print(args[0]!)}, ${print(args[1]!)})`) },
	{
		op: "str.repeat",
		impl: "native",
		because: "`binary:copy/2` repeats a binary natively",
		cost: allocating,
		emit: (args) => raw(`binary:copy(${print(args[0]!)}, ${print(args[1]!)})`),
	},
	{ op: "str.padStart", impl: "library", cost: allocating, emit: (args) => raw(`erl_support:erl_pad_start(${print(args[0]!)}, ${print(args[1]!)}, ${print(args[2]!)})`) },
	{
		op: "str.trim",
		impl: "native",
		because: "`string:trim/3` takes the cut set explicitly, so the 25 code points are exact",
		cost: allocating,
		emit: (args) => raw(`string:trim(${print(args[0]!)}, both, ${literal(TRIM_CODE_POINTS as unknown as Value)})`),
	},
	{
		op: "str.asciiUpper",
		impl: "native",
		requires: argIsAscii(0),
		because: "a byte-wise pass maps a-z and leaves every other byte alone, which is exact only for ASCII",
		cost: allocating,
		emit: (args) => raw(`erl_support:erl_ascii_upper(${print(args[0]!)})`),
	},
	{
		op: "str.asciiLower",
		impl: "native",
		requires: argIsAscii(0),
		cost: allocating,
		emit: (args) => raw(`erl_support:erl_ascii_lower(${print(args[0]!)})`),
	},
	{
		op: "str.asciiUpper",
		impl: "portable",
		cost: scalarPass,
		sourceFn: "std/strings::asciiUpperAll",
		emit: (args, _types, ctx) => ({ kind: "call", callee: { kind: "name", name: ctx.nameOf("std/strings::asciiUpperAll") }, args }),
	},
	{
		op: "str.asciiLower",
		impl: "portable",
		cost: scalarPass,
		sourceFn: "std/strings::asciiLowerAll",
		emit: (args, _types, ctx) => ({ kind: "call", callee: { kind: "name", name: ctx.nameOf("std/strings::asciiLowerAll") }, args }),
	},
	{
		op: "str.compare",
		impl: "native",
		because: "Erlang orders binaries byte by byte, which is code point order for UTF-8",
		cost: linear,
		emit: (args) => raw(`erl_support:erl_compare(${print(args[0]!)}, ${print(args[1]!)})`),
	},
	{
		op: "str.codePoints",
		impl: "native",
		cost: allocating,
		emit: (args) => raw(`unicode:characters_to_list(${print(args[0]!)}, utf8)`),
	},
	{
		op: "str.fromCodePoints",
		impl: "native",
		cost: allocating,
		emit: (args) => raw(`unicode:characters_to_binary(${print(args[0]!)}, utf8)`),
	},
	{ op: "str.asAscii", impl: "library", cost: linear, emit: (args) => raw(`erl_support:erl_as_ascii(${print(args[0]!)})`) },
	{ op: "str.asDigits", impl: "library", cost: linear, emit: (args) => raw(`erl_support:erl_as_digits(${print(args[0]!)})`) },
	{
		op: "str.split",
		impl: "native",
		because: "`binary:split/3` with `global` is one pass",
		cost: allocating,
		emit: (args) => raw(`binary:split(${print(args[0]!)}, ${print(args[1]!)}, [global])`),
	},
	{
		op: "str.join",
		impl: "native",
		cost: allocating,
		emit: (args) => raw(`iolist_to_binary(lists:join(${print(args[1]!)}, ${print(args[0]!)}))`),
	},
	{
		op: "str.fromInt",
		impl: "native",
		cost: allocating,
		emit: (args) => raw(`integer_to_binary(${print(args[0]!)})`),
	},
	{ op: "str.parseInt", impl: "library", cost: linear, emit: (args) => raw(`erl_support:erl_parse_digits(${print(args[0]!)})`) },

	{ op: "seq.at", impl: "library", cost: cheap, emit: (args) => raw(`erl_support:erl_at(${print(args[0]!)}, ${print(args[1]!)})`) },
	{ op: "seq.get", impl: "native", cost: cheap, emit: (args) => raw(`lists:nth((${print(args[1]!)}) + 1, ${print(args[0]!)})`) },
	{ op: "seq.len", impl: "native", cost: linear, emit: (args) => raw(`length(${print(args[0]!)})`) },
	// `seq.push` never runs through this: `lower.ts`'s `pushStatement` calls it directly and wraps
	// the result in a bare `expr` statement, which `compileStmts` intercepts by this sentinel `op`
	// tag before it would ever reach `print` — see the module doc.
	{ op: "seq.push", impl: "native", cost: allocating, emit: (args) => ({ kind: "binary", op: PUSH_OP, left: args[0]!, right: args[1]! }) },
	{ op: "seq.sum", impl: "library", cost: linear, emit: (args) => raw(`lists:sum(${print(args[0]!)})`) },
	{ op: "seq.contains", impl: "native", cost: linear, emit: (args) => raw(`lists:member(${print(args[1]!)}, ${print(args[0]!)})`) },
	{ op: "seq.indexOf", impl: "library", cost: linear, emit: (args) => raw(`erl_support:erl_seq_index_of(${print(args[0]!)}, ${print(args[1]!)})`) },
	{ op: "seq.concat", impl: "native", cost: allocating, emit: (args) => raw(`(${print(args[0]!)} ++ ${print(args[1]!)})`) },
	{
		op: "seq.slice",
		impl: "library",
		cost: allocating,
		emit: (args) => raw(`lists:sublist(${print(args[0]!)}, (${print(args[1]!)}) + 1, (${print(args[2]!)}) - (${print(args[1]!)}))`),
	},
	{ op: "seq.reverse", impl: "native", cost: allocating, emit: (args) => raw(`lists:reverse(${print(args[0]!)})`) },
	{
		op: "seq.sortStable",
		impl: "native",
		because: "`lists:sort/2` is documented stable",
		cost: { alloc: "one", time: "nlogn" },
		// Built as a structured node, not `raw`+`print`: `args[1]` is a lambda, and only `compileExpr`
		// (not the stateless `print` candidates otherwise use) compiles a lambda body correctly —
		// see `print`'s own module doc.
		emit: (args) => callExpr("lists:sort", [threeWayComparator(args[1]!), args[0]!]),
	},
	{
		op: "seq.sortStableBy",
		impl: "native",
		because: "comparing the key's own value directly needs no comparator argument, unlike Go's",
		cost: { alloc: "one", time: "nlogn" },
		emit: (args) => callExpr("lists:sort", [keyComparator(args[1]!), args[0]!]),
	},
	{ op: "seq.map", impl: "native", cost: allocating, emit: (args) => callExpr("lists:map", [args[1]!, args[0]!]) },
	{ op: "seq.filter", impl: "native", cost: allocating, emit: (args) => callExpr("lists:filter", [args[1]!, args[0]!]) },
	{ op: "seq.any", impl: "native", cost: linear, emit: (args) => callExpr("lists:any", [args[1]!, args[0]!]) },
	{ op: "seq.all", impl: "native", cost: linear, emit: (args) => callExpr("lists:all", [args[1]!, args[0]!]) },
	{ op: "seq.find", impl: "library", cost: linear, emit: (args) => callExpr("erl_support:erl_find", [args[0]!, args[1]!]) },

	{ op: "dec.fromScaled", impl: "native", cost: cheap, emit: (args) => args[0]! },
	{ op: "dec.fromInt", impl: "native", cost: cheap, emit: (args, types) => raw(`(${print(args[0]!)}) * ${10 ** scaleOf(types[1])}`) },
	{ op: "dec.add", impl: "native", cost: cheap, emit: binary("+") },
	{ op: "dec.sub", impl: "native", cost: cheap, emit: binary("-") },
	{ op: "dec.mul", impl: "native", cost: cheap, emit: binary("*") },
	{ op: "dec.compare", impl: "native", cost: cheap, emit: (args) => raw(`erl_support:erl_compare_ints(${print(args[0]!)}, ${print(args[1]!)})`) },
	{ op: "dec.isNegative", impl: "native", cost: cheap, emit: (args) => raw(`(${print(args[0]!)} < 0)`) },
	{ op: "dec.abs", impl: "native", cost: cheap, emit: (args) => raw(`abs(${print(args[0]!)})`) },
	{ op: "dec.unscaled", impl: "native", cost: cheap, emit: (args) => args[0]! },

	{ op: "date.clampEpochDays", impl: "native", cost: cheap, emit: (args) => raw(`min(max(${print(args[0]!)}, -719162), 2932896)`) },
	{ op: "date.toEpochDays", impl: "native", cost: cheap, emit: (args) => args[0]! },
	{ op: "date.fromEpochDays", impl: "library", cost: cheap, emit: (args) => raw(`erl_support:erl_date_from_epoch_days(${print(args[0]!)})`) },
	{
		op: "date.fromYmd",
		impl: "portable",
		cost: linear,
		sourceFn: "std/date::ymdToDays",
		emit: (args, _types, ctx) => ({ kind: "call", callee: { kind: "name", name: ctx.nameOf("std/date::ymdToDays") }, args }),
	},
	{ op: "date.year", impl: "portable", cost: cheap, sourceFn: "std/date::yearFromDays", emit: (args, _types, ctx) => ({ kind: "call", callee: { kind: "name", name: ctx.nameOf("std/date::yearFromDays") }, args }) },
	{ op: "date.month", impl: "portable", cost: cheap, sourceFn: "std/date::monthFromDays", emit: (args, _types, ctx) => ({ kind: "call", callee: { kind: "name", name: ctx.nameOf("std/date::monthFromDays") }, args }) },
	{ op: "date.day", impl: "portable", cost: cheap, sourceFn: "std/date::dayFromDays", emit: (args, _types, ctx) => ({ kind: "call", callee: { kind: "name", name: ctx.nameOf("std/date::dayFromDays") }, args }) },
	{ op: "date.addDays", impl: "library", cost: cheap, emit: (args) => raw(`erl_support:erl_date_add_days(${print(args[0]!)}, ${print(args[1]!)})`) },
	{ op: "date.diffDays", impl: "native", cost: cheap, emit: binary("-") },
	{ op: "date.compare", impl: "library", cost: cheap, emit: (args) => raw(`erl_support:erl_compare_ints(${print(args[0]!)}, ${print(args[1]!)})`) },
	{ op: "date.dayOfWeek", impl: "native", cost: cheap, emit: (args) => raw(`(((${print(args[0]!)} + 3) rem 7 + 7) rem 7 + 1)`) },
	{
		op: "date.isLeapYear",
		impl: "native",
		cost: cheap,
		emit: (args) =>
			raw(
				`(((${print(args[0]!)} rem 4 =:= 0) andalso (${print(args[0]!)} rem 100 =/= 0)) orelse (${print(args[0]!)} rem 400 =:= 0))`,
			),
	},

	{
		// Same reasoning as Go's and Rust's: every class this project's regexes use is ASCII, so a
		// byte-wise scan never needs to decode UTF-8, and a multi-byte scalar's bytes are all >= 0x80
		// and fail an ASCII range test the same way decoding and testing the scalar would.
		op: "re.retain",
		impl: "native",
		because: "a byte-wise scan when every retained range is ASCII",
		cost: allocating,
		emit: (args, _types, ctx) => {
			const ranges = ctx.regex === undefined || ctx.regex.node.kind !== "class" ? [] : ctx.regex.node.ranges;
			const asciiTest = (name: string): string =>
				ranges.length === 0
					? "false"
					: ranges.map((range) => (range.lo === range.hi ? `${name} =:= ${range.lo}` : `(${name} >= ${range.lo} andalso ${name} =< ${range.hi})`)).join(" orelse ");
			if (ranges.every((range) => range.hi <= 127)) {
				return raw(`<< <<__b>> || <<__b>> <= ${print(args[0]!)}, ${asciiTest("__b")} >>`);
			}
			const pattern = ctx.regex === undefined ? "" : printRegex(ctx.regex.node, "go");
			return raw(`erl_support:erl_retain(${erlString(`[^${classBody(pattern)}]`)}, ${print(args[0]!)})`);
		},
	},
	{
		op: "re.test",
		impl: "native",
		because: "the normalized pattern is inside the compatibility subset; \\A…\\z anchors the whole string, exactly as PCRE's own \\A…\\z do",
		cost: linear,
		emit: (args, _types, ctx) => {
			const pattern = ctx.regex === undefined ? "" : printRegex(ctx.regex.node, "go");
			return raw(`erl_support:erl_regex_test(${erlString(`\\A${pattern}\\z`)}, ${print(args[0]!)})`);
		},
	},

	{
		op: "http.request",
		impl: "native",
		cost: { alloc: "many", time: "linear" },
		emit: (args, _types, ctx) => raw(`(maps:get(request, ${print(ctx.env())}))(${print(args[0]!)})`),
	},
	{ op: "clock.now", impl: "native", cost: cheap, emit: (_args, _types, ctx) => raw(`(maps:get(now, ${print(ctx.env())}))()`) },
	{ op: "clock.sleep", impl: "native", cost: cheap, emit: (args, _types, ctx) => raw(`(maps:get(sleep, ${print(ctx.env())}))(${print(args[0]!)})`) },
	{ op: "clock.millis", impl: "native", cost: cheap, emit: (args) => args[0]! },
	{ op: "clock.durationMillis", impl: "native", cost: cheap, emit: (args) => args[0]! },
	{ op: "clock.elapsed", impl: "native", cost: cheap, emit: (args) => raw(`max(0, (${print(args[1]!)}) - (${print(args[0]!)}))`) },
	{ op: "random.nextU32", impl: "native", cost: cheap, emit: (_args, _types, ctx) => raw(`(maps:get(next_u32, ${print(ctx.env())}))()`) },
	{
		op: "task.race",
		impl: "library",
		because: "spawning a process per task and racing on messages is the idiomatic form",
		cost: { alloc: "many", time: "linear" },
		// `args[0]` is a list of lambdas, so this is a structured node too — see `seq.sortStable`'s
		// comment just above.
		emit: (args) => callExpr("erl_support:erl_race_first_some", [args[0]!]),
	},
];

/** The body of a printed class, so `re.retain`'s literal-class negation can strip the brackets. */
function classBody(printed: string): string {
	return printed.startsWith("[") && printed.endsWith("]") ? printed.slice(1, -1) : printed;
}

export const ERLANG_SPEC: TargetSpec = {
	name: "erlang",
	table: new LoweringTable(ERLANG_CANDIDATES),
	naming: {
		func: (name) => snake(name),
		value: (name) => pascal(name),
		field: (name) => snake(name),
		// `PascalCase`, kept (not `snake`) specifically because a domain error's tag is this name,
		// quoted, and the differential driver reports a failure by that exact class name — see
		// `compileStmts`'s `"throw"` case and `driverFiles`'s error decoding.
		type: (name) => pascal(name),
		// The `.erl` file name has to match its `-module(...)` atom exactly (`moduleAtom` below), which
		// is what the code loader looks a module up by — not merely a style convention.
		module: (path) => `${moduleAtom(path)}.erl`,
	},
	// A fold or a map/filter over a list is exactly the recursive-fun shape every other loop needs
	// here, so it goes through the same machinery as a hand-written `for`/`for…of` rather than
	// needing its own `seq.fold`/`seq.map`/`seq.filter` capability-table entries at all.
	loopCombinators: new Set(["seq.fold", "seq.map", "seq.filter"]),
	// Erlang's `case`/`if` are ordinary expressions, so `cond` never needs statement hoisting.
	statementTernary: false,
	// `{Value, nil}` on success, `{Zero, {ErrorTag, Message}}` on failure — see the module doc.
	errorsAsValues: true,
	asyncColouring: false,
	envType: { kind: "Record", name: "Capabilities" },
};

/* ------------------------------------------------------------------ *
 * The imperative-to-functional compiler.
 *
 * `docs/targets/erlang.md` names the scheme; this is the one place it is implemented. A function
 * body (or a lambda body, which is compiled the same way) is not printed statement by statement —
 * it is compiled, once, into a single Erlang expression, by always inlining "what comes next"
 * into every point normal control can still reach: the non-terminal arm of an `if`/`switch`, a
 * loop's exhausted clause, and every `break`. `return`, `fail` and `continue` never receive that
 * treatment, because they never need it — see the module doc for why not.
 * ------------------------------------------------------------------ */

/** Per-function compilation state: the one thing that must never repeat a name (see the module doc). */
type Ctx = {
	readonly versions: Map<string, number>;
	/** Erlang function name -> the module atom that defines it, for a qualified `Module:fn(...)` call. */
	readonly moduleOf: ReadonlyMap<string, string>;
	/**
	 * A hoisted constant table's name (`hoistConstantTables` in the shared lowerer, which names it
	 * through the same `naming.value` this backend gives every local — `PascalCase`) is not a
	 * variable at all by the time it is printed: Erlang has no module-level binding *except* a
	 * function, so `printModule` below declares each one as a zero-argument function and every read
	 * of it has to be spelled as a call to that function, not a bare name. Membership here is what a
	 * `"name"` node consults to tell the two apart.
	 */
	readonly constantNames: ReadonlySet<string>;
	/**
	 * Every name `bind` has minted for this function, in minting order: a `let`/`assign` that turns
	 * out to be a dead store, and a loop-fun, lambda or top-level parameter nothing reads, are both
	 * exactly as unused to `erlc` — and both are handled the same way, by the same one pass over the
	 * *finished* function text, `suppressUnusedBindings`, since a decision made at the point any of
	 * them is printed cannot yet see the dead-code elimination that same pass also does (a fuzzer-
	 * found bug this project's docs/targets/erlang.md records). This is the list that pass walks.
	 */
	readonly allBound: string[];
};

/** The current SSA binding of every Core-mutable local reachable at this point in the compile. */
type Env = Map<string, string>;

/** A continuation: "compile whatever comes after this point, given these current bindings." */
type Cont = (env: Env) => string;

function newCtx(moduleOf: ReadonlyMap<string, string>, constantNames: ReadonlySet<string> = new Set()): Ctx {
	return { versions: new Map(), moduleOf, constantNames, allBound: [] };
}

/** A hoisted constant's name, quoted so `PascalCase` is a legal Erlang atom, called with no arguments. */
function constantRef(name: string): string {
	return `'${name}'()`;
}

/**
 * Mints a fresh Erlang variable for `base` (already `PascalCase`, from `naming.value`) and records
 * it as `base`'s current binding. Every call anywhere in one function draws from the same counter,
 * so `Sum`, `Sum1`, `Sum2`, … never repeats — the guarantee the module doc explains is what keeps
 * `erlc +warn_unused_vars +warnings_as_errors` from ever seeing a shadowed variable.
 */
function bind(ctx: Ctx, env: Env, base: string): string {
	const version = ctx.versions.get(base) ?? 0;
	ctx.versions.set(base, version + 1);
	const name = version === 0 ? base : `${base}${version}`;
	env.set(base, name);
	ctx.allBound.push(name);
	return name;
}

/**
 * True only when `expr` provably calls nothing: a plain expression of literals, names and
 * operators. Every call this printer ever emits — a local function, `module:fn(...)`, a BIF like
 * `element(2, X)`, a quoted constant's `'Name'()` — looks like a lowercase identifier or a `'`
 * immediately followed by `(`, so the absence of that shape is decisive, not a guess: nothing else
 * in the Target AST prints a call any other way. Used only to decide whether a dead binding's whole
 * line can be deleted outright rather than merely renamed — see `suppressUnusedBindings`.
 */
function isPureExpr(expr: string): boolean {
	return !/[a-z_][a-zA-Z0-9_]*\s*\(/.test(expr) && !expr.includes("'");
}

/**
 * Handles every dead `let`/`assign` `bind` minted (see `Ctx.allBound`'s doc) — a name `erlc` would
 * otherwise reject as unused, or, one level further, an *upstream* name whose only reader was
 * itself dead (`docs/targets/erlang.md`'s fuzz run found both shapes; the second is what makes this
 * a fixed point rather than one pass).
 *
 * A name occurs exactly once in the text precisely when that one occurrence is its own binding and
 * nothing ever reads it back — `bind`'s uniqueness guarantee means a second occurrence can only be
 * a real read, never an unrelated name that merely looks the same. When the dead binding's own
 * value expression is provably pure (`isPureExpr`), the whole `Name = Expr,` line is deleted
 * outright rather than renamed to `_Name`: deleting it is what can make an *earlier* binding dead
 * in turn (its only reader is now gone), which is why this loops to a fixed point; renaming alone
 * cannot, because the reference inside the renamed line's own right-hand side is still there for
 * `erlc`'s own dead-value analysis to trace upstream from and warn about (confirmed against `erlc`
 * directly in the session scratch — a plain rename does not silence that warning, only removing the
 * line does). A binding whose value is *not* provably pure (a call — the one shape that might be a
 * capability effect, like `http.request`, that must run even if nothing then reads its result) is
 * only ever renamed, never deleted, exactly like a genuinely unused name always was.
 *
 * A loop-fun, lambda or top-level parameter is printed at its raw, minted spelling and handled by
 * this same pass, not decided at the point it is printed — see `Ctx.allBound`'s own doc for why.
 */
function suppressUnusedBindings(body: string, names: readonly string[]): string {
	let out = body;
	for (let round = 0; round < 50; round++) {
		let changed = false;
		for (const name of names) {
			const pattern = new RegExp(`\\b${name}\\b`, "g");
			const matches = out.match(pattern);
			if (matches === null || matches.length !== 1) continue;
			const lineRe = new RegExp(`^([ \\t]*)${name} = (.*),$`, "m");
			const line = lineRe.exec(out);
			if (line !== null && isPureExpr(line[2]!)) {
				out = out.replace(`${line[0]}\n`, "");
			} else {
				out = out.replace(pattern, `_${name}`);
			}
			changed = true;
		}
		if (!changed) break;
	}
	return out;
}

function resolveName(env: Env, base: string): string {
	return env.get(base) ?? base;
}

/**
 * Rewrites every whole-word occurrence of a base name `env` currently rebinds into its live SSA
 * name. Used only on a `raw` fragment's text — see `print`'s module doc for why that text can
 * still be carrying the plain, unversioned spelling. Safe against false matches: a base name is
 * always `PascalCase` (`naming.value`) and nothing else this printer ever emits is, so `\bBase\b`
 * cannot collide with an atom, a module-qualified call or an operator keyword.
 */
function substituteEnv(text: string, env: Env): string {
	let out = text;
	for (const [base, current] of env) {
		if (base === current) continue;
		out = out.replace(new RegExp(`\\b${base}\\b`, "g"), current);
	}
	return out;
}

/**
 * Qualifies every call to a cross-module function inside a `raw` fragment's text with its module
 * atom — the same problem `substituteEnv` solves for a variable, but for a function name: `print`
 * (used inside a candidate's `emit`) has no `ctx.moduleOf` to consult either, so a nested `call`
 * a candidate's own `raw` text embeds (`str.concat` of two library calls, say) comes out as a bare
 * name, exactly like a `let`-bound local comes out unversioned. Every generated function name is
 * unique over the whole program (`Lowerer.assignNames` assigns the closure's names in one pass),
 * so a bare `\bname\(` can only ever mean a call to that one function — there is no local
 * `name(...)` this rewrite could be confusing it with.
 */
function qualifyCalls(text: string, moduleOf: ReadonlyMap<string, string>): string {
	let out = text;
	for (const [name, atom] of moduleOf) {
		out = out.replace(new RegExp(`\\b${name}\\(`, "g"), `${atom}:${name}(`);
	}
	return out;
}

/** The `raw`-fragment counterpart of `Ctx.constantNames`'s check in `compileExpr`'s `"name"` case. */
function resolveConstants(text: string, constantNames: ReadonlySet<string>): string {
	let out = text;
	for (const name of constantNames) {
		out = out.replace(new RegExp(`\\b${name}\\b(?!\\()`, "g"), constantRef(name));
	}
	return out;
}

function erlOperator(op: string): string {
	switch (op) {
		case "&&":
			return "andalso";
		case "||":
			return "orelse";
		case "==":
		case "===":
			return "=:=";
		case "!=":
		case "!==":
			return "=/=";
		case "<=":
			return "=<";
		default:
			return op;
	}
}

/** Renders an expression. Never mutates `env`: every binding happens in `compileStmts`. */
function compileExpr(ctx: Ctx, env: Env, expr: TExpr): string {
	switch (expr.kind) {
		case "lit":
			return literal(expr.value);
		case "name":
			return ctx.constantNames.has(expr.name) ? constantRef(expr.name) : resolveName(env, expr.name);
		case "raw":
			// See `print`'s module doc: a candidate-built fragment carries plain, unversioned names,
			// unqualified cross-module calls and bare references to a hoisted constant, and this is
			// where all three become whatever SSA name is actually live here, whichever module
			// actually defines the callee, and a call to the constant's own zero-arg function
			// (`substituteEnv`, `qualifyCalls`, `resolveConstants`).
			return resolveConstants(qualifyCalls(substituteEnv(expr.text, env), ctx.moduleOf), ctx.constantNames);
		case "call": {
			const callee = expr.callee.kind === "name" ? expr.callee.name : `(${compileExpr(ctx, env, expr.callee)})`;
			const target = expr.callee.kind === "name" ? ctx.moduleOf.get(expr.callee.name) : undefined;
			const qualified = target === undefined ? callee : `${target}:${callee}`;
			return `${qualified}(${expr.args.map((arg) => compileExpr(ctx, env, arg)).join(", ")})`;
		}
		case "method":
			// No target ever selects this shape (every candidate above emits `call`/`raw`), kept only
			// so the printer stays total over the shared Target AST.
			return `${compileExpr(ctx, env, expr.target)}:${snake(expr.name)}(${expr.args.map((arg) => compileExpr(ctx, env, arg)).join(", ")})`;
		case "member":
			return `maps:get(${snake(expr.name)}, ${compileExpr(ctx, env, expr.target)})`;
		case "index":
			return `lists:nth((${compileExpr(ctx, env, expr.index)}) + 1, ${compileExpr(ctx, env, expr.target)})`;
		case "binary":
			return `(${compileExpr(ctx, env, expr.left)} ${erlOperator(expr.op)} ${compileExpr(ctx, env, expr.right)})`;
		case "unary": {
			if (expr.op === "!" && expr.operand.kind === "binary" && expr.operand.op === "==") {
				return `(${compileExpr(ctx, env, expr.operand.left)} =/= ${compileExpr(ctx, env, expr.operand.right)})`;
			}
			if (expr.op === "!") return `(not ${compileExpr(ctx, env, expr.operand)})`;
			return `(${expr.op}${compileExpr(ctx, env, expr.operand)})`;
		}
		case "ternary":
			return `(case ${compileExpr(ctx, env, expr.test)} of true -> ${compileExpr(ctx, env, expr.then)}; false -> ${compileExpr(ctx, env, expr.otherwise)} end)`;
		case "list":
			return `[${expr.items.map((item) => compileExpr(ctx, env, item)).join(", ")}]`;
		case "record":
			return `#{${expr.fields.map((field) => `${snake(field.name)} => ${compileExpr(ctx, env, field.value)}`).join(", ")}}`;
		case "lambda": {
			const lambdaEnv: Env = new Map(env);
			const params = expr.params.map((param) => bind(ctx, lambdaEnv, param.name));
			const body = compileStmts(ctx, lambdaEnv, expr.body, 0, unreachableCont("lambda body fell through"), undefined, undefined);
			// An unused parameter here is left for `suppressUnusedBindings` to underscore in
			// `printFunction`'s one finishing pass over the whole function text, not decided here —
			// see that function's own doc for why a per-site decision is the wrong place for it.
			return `fun(${params.join(", ")}) ->\n${indent(body)}\nend`;
		}
		case "none":
			return "none";
		case "zero":
			return "undefined";
		case "some":
			return `{some, ${compileExpr(ctx, env, expr.inner)}}`;
		default: {
			const exhaustive: never = expr;
			return exhaustive;
		}
	}
}

/** Every outer-scope mutable local this statement list reassigns, transitively through nested control flow. */
function collectAssignedNames(stmts: readonly TStmt[]): Set<string> {
	const found = new Set<string>();
	const visitExpr = (expr: TExpr): void => {
		if (expr.kind === "binary" && (expr.op === PUSH_OP || expr.op === SET_INDEX_OP) && expr.left.kind === "name") {
			found.add(expr.left.name);
		}
	};
	const visit = (list: readonly TStmt[]): void => {
		for (const stmt of list) {
			switch (stmt.kind) {
				case "assign":
					if (stmt.target.kind === "name") found.add(stmt.target.name);
					else if (stmt.target.kind === "index" && stmt.target.target.kind === "name") found.add(stmt.target.target.name);
					break;
				case "expr":
					visitExpr(stmt.expr);
					break;
				case "if":
					visit(stmt.then);
					visit(stmt.otherwise);
					break;
				case "switch":
					for (const entry of stmt.cases) visit(entry.body);
					if (stmt.otherwise !== undefined) visit(stmt.otherwise);
					break;
				case "for":
				case "forEach":
					visit(stmt.body);
					break;
				default:
					break;
			}
		}
	};
	visit(stmts);
	return found;
}

function unreachableCont(why: string): Cont {
	return () => `erlang:error(${erlString(`unreachable: ${why}`)})`;
}

function indent(text: string, depth = 1): string {
	const pad = "    ".repeat(depth);
	return text
		.split("\n")
		.map((line) => (line === "" ? line : `${pad}${line}`))
		.join("\n");
}

/**
 * Compiles `stmts[idx..]` into one Erlang expression.
 *
 * `fallOff` is what to compile when control runs off the end of *this* statement list without an
 * explicit `return`/`fail`/`break`/`continue`: normal completion of whatever construct `stmts` is
 * the body of — the rest of the enclosing block for a straight-line list, or a tail call to the
 * loop for a loop's own body. It changes at every level of nesting (each `if`/`switch` branch gets
 * its own, meaning "continue with whatever follows that construct"), which is exactly why it is
 * the wrong thing for an explicit `continue` to mean: `continue` always means "next iteration of
 * the *innermost* loop", not "next statement of the block this `continue` happens to sit in", so it
 * needs its own reference that `if`/`switch` pass down unchanged instead of rebinding — `onContinue`.
 * `onBreak`, present only inside a loop body and passed down the same unchanging way, is what a
 * `break` compiles to: the same "whatever comes after the loop" continuation the loop's own
 * exhausted clause uses, evaluated with the bindings current at the `break` rather than the loop's
 * final ones. None of the three is a tag threaded through a return value — all three are literally
 * inlined at every point they apply, which is the whole scheme (see the module doc).
 */
function compileStmts(
	ctx: Ctx,
	env: Env,
	stmts: readonly TStmt[],
	idx: number,
	fallOff: Cont,
	onBreak: Cont | undefined,
	onContinue: Cont | undefined,
): string {
	if (idx >= stmts.length) return fallOff(env);
	const stmt = stmts[idx]!;
	const rest: Cont = (e) => compileStmts(ctx, e, stmts, idx + 1, fallOff, onBreak, onContinue);

	switch (stmt.kind) {
		case "let": {
			const value = compileExpr(ctx, env, stmt.init);
			const name = bind(ctx, env, stmt.name);
			return `${name} = ${value},\n${rest(env)}`;
		}
		case "multiLet": {
			const value = compileExpr(ctx, env, stmt.init);
			const names = stmt.names.map((n) => bind(ctx, env, n));
			return `{${names.join(", ")}} = ${value},\n${rest(env)}`;
		}
		case "assign": {
			if (stmt.target.kind === "index" && stmt.target.target.kind === "name") {
				const base = stmt.target.target.name;
				const list = resolveName(env, base);
				const index = compileExpr(ctx, env, stmt.target.index);
				const value = compileExpr(ctx, env, stmt.value);
				const name = bind(ctx, env, base);
				return `${name} = erl_support:erl_list_set(${list}, ${index}, ${value}),\n${rest(env)}`;
			}
			if (stmt.target.kind === "name") {
				const value = compileExpr(ctx, env, stmt.value);
				const name = bind(ctx, env, stmt.target.name);
				return `${name} = ${value},\n${rest(env)}`;
			}
			// Unreachable in this project: `lower.ts` only ever builds a `name` or `index` target.
			return `_ = ${compileExpr(ctx, env, stmt.value)},\n${rest(env)}`;
		}
		case "expr": {
			if (stmt.expr.kind === "binary" && stmt.expr.op === PUSH_OP && stmt.expr.left.kind === "name") {
				const base = stmt.expr.left.name;
				const list = resolveName(env, base);
				const value = compileExpr(ctx, env, stmt.expr.right);
				const name = bind(ctx, env, base);
				return `${name} = (${list} ++ [${value}]),\n${rest(env)}`;
			}
			return `_ = ${compileExpr(ctx, env, stmt.expr)},\n${rest(env)}`;
		}
		case "if": {
			const test = compileExpr(ctx, env, stmt.test);
			const thenBranch = compileStmts(ctx, new Map(env), stmt.then, 0, rest, onBreak, onContinue);
			const elseBranch =
				stmt.otherwise.length === 0
					? rest(new Map(env))
					: compileStmts(ctx, new Map(env), stmt.otherwise, 0, rest, onBreak, onContinue);
			return `case ${test} of\n${indent(`true ->\n${indent(thenBranch)};`)}\n${indent(`false ->\n${indent(elseBranch)}`)}\nend`;
		}
		case "switch": {
			const subjectName = bind(ctx, env, "Subject");
			const subject = compileExpr(ctx, env, stmt.subject);
			const clauses = stmt.cases.map((entry) => {
				const test = entry.values.map((value) => `${subjectName} =:= ${literal(value)}`).join(" orelse ");
				const body = compileStmts(ctx, new Map(env), entry.body, 0, rest, onBreak, onContinue);
				return `${test} ->\n${indent(body)};`;
			});
			const fallback =
				stmt.otherwise === undefined
					? `true ->\n${indent(unreachableCont("non-exhaustive switch, which the checker proves cannot happen")(env))}`
					: `true ->\n${indent(compileStmts(ctx, new Map(env), stmt.otherwise, 0, rest, onBreak, onContinue))}`;
			return `${subjectName} = ${subject},\nif\n${indent([...clauses, fallback].join("\n"))}\nend`;
		}
		case "for":
			return compileFor(ctx, env, stmt, rest);
		case "forEach":
			return compileForEach(ctx, env, stmt, rest);
		case "return": {
			const value = stmt.value === undefined ? "ok" : compileExpr(ctx, env, stmt.value);
			if (stmt.extra === undefined) return value;
			return `{${value}, ${stmt.extra.map((item) => compileExpr(ctx, env, item)).join(", ")}}`;
		}
		case "throw": {
			const message = stmt.args.length === 0 ? erlString("") : compileExpr(ctx, env, stmt.args[0]!);
			// Quoted so the class's own `PascalCase` name (`naming.type`) is the atom, verbatim: the
			// differential driver reports a failure with `atom_to_binary(ErrorTag, utf8)`, and the
			// reference interpreter's own failures are that same class name, unchanged.
			return `{undefined, {'${stmt.errorClass}', ${message}}}`;
		}
		case "break":
			if (onBreak === undefined) throw new Error("erlang backend: break outside a loop");
			return onBreak(env);
		case "continue":
			if (onContinue === undefined) throw new Error("erlang backend: continue outside a loop");
			return onContinue(env);
		case "raw":
			return stmt.text;
		default: {
			const exhaustive: never = stmt;
			return exhaustive;
		}
	}
}

/** `forRange`: a self-recursive `fun` counting the induction variable, guarded by the exhaustion test. */
function compileFor(ctx: Ctx, env: Env, stmt: Extract<TStmt, { kind: "for" }>, rest: Cont): string {
	const carried = [...collectAssignedNames(stmt.body)].filter((name) => env.has(name));
	const toValue = bind(ctx, env, "Bound");
	const toExpr = compileExpr(ctx, env, stmt.to);
	const fromExpr = compileExpr(ctx, env, stmt.from);
	const initialCarried = carried.map((base) => resolveName(env, base));

	const loopName = bind(ctx, env, "Loop");
	const paramEnv: Env = new Map(env);
	const indexParam = bind(ctx, paramEnv, stmt.name);
	const carriedParams = carried.map((base) => bind(ctx, paramEnv, base));
	const params = [indexParam, ...carriedParams];

	// Both arms of the guard below sit inside the *same* fun clause (a `case`, not a pattern per
	// arm — the guard needs a comparison, which a plain pattern cannot express), so a parameter is
	// "used" for `+warn_unused_vars`'s purposes if either arm reads it.
	const exhaustedBody = rest(new Map(paramEnv));
	const onBreak: Cont = (e) => rest(e);
	const tailCall: Cont = (e) => {
		const nextIndex = `(${resolveName(e, stmt.name)}) + (${stmt.step})`;
		const args = [nextIndex, ...carried.map((base) => resolveName(e, base))];
		return `${loopName}(${args.join(", ")})`;
	};
	const recursiveBody = compileStmts(ctx, new Map(paramEnv), stmt.body, 0, tailCall, onBreak, tailCall);

	const comparison = stmt.step > 0n ? (stmt.inclusive ? ">" : ">=") : stmt.inclusive ? "<" : "=<";
	const guard = `${indexParam} ${comparison} ${toValue}`;

	const funBody = `case ${guard} of\n${indent(`true ->\n${indent(exhaustedBody)};\nfalse ->\n${indent(recursiveBody)}`)}\nend`;
	const selfRef = selfReference(loopName, funBody);

	// An unused carried parameter (`params` beyond the index, which the guard above always reads)
	// is left for `suppressUnusedBindings` to underscore in its one finishing pass over the whole
	// function text — see that function's own doc for why a per-site decision here would be wrong.
	return [
		`${toValue} = ${toExpr},`,
		`${loopName} = fun ${selfRef}(${params.join(", ")}) ->`,
		indent(funBody),
		"end,",
		`${loopName}(${[fromExpr, ...initialCarried].join(", ")})`,
	].join("\n");
}

/**
 * A named fun's self-reference (`fun Name(...) -> ... end`) has its own "used" check, separate
 * from the outer variable it is bound to: a loop whose every path is terminal — every branch
 * `return`s, `break`s or fails before ever reaching a tail call — never actually recurses, and
 * `erlc` (correctly) reports that name unused even though the *binding* is plainly called right
 * after (`t11.erl` in the session scratch confirmed this). Underscoring it here, only when the
 * body truly never calls it back, is what keeps that from failing `+warnings_as_errors`; the
 * outer binding keeps its real name either way, since that one is never in question.
 */
function selfReference(loopName: string, body: string): string {
	return body.includes(`${loopName}(`) ? loopName : `_${loopName}`;
}

/** `forEach`: a self-recursive `fun` over `[Head | Tail]`, one clause for `[]` and one for a non-empty list. */
function compileForEach(ctx: Ctx, env: Env, stmt: Extract<TStmt, { kind: "forEach" }>, rest: Cont): string {
	const carried = [...collectAssignedNames(stmt.body)].filter((name) => env.has(name));
	const iterableExpr = compileExpr(ctx, env, stmt.iterable);
	const initialCarried = carried.map((base) => resolveName(env, base));

	const loopName = bind(ctx, env, "Loop");

	// The two clauses below are separate scopes — Erlang gives each of a fun's clauses its own,
	// unrelated bindings — so a carried variable gets a *separate* mint per clause, not one shared
	// between them: sharing one would make its occurrence count at least 2 (once per clause head)
	// even when neither clause body ever reads it, which is exactly the wrong count for
	// `suppressUnusedBindings`'s "exactly one occurrence" test in `printFunction` to work from.
	const exhaustedParamEnv: Env = new Map(env);
	const exhaustedParams = carried.map((base) => bind(ctx, exhaustedParamEnv, base));
	const exhaustedBody = rest(exhaustedParamEnv);
	const onBreak: Cont = (e) => rest(e);

	const recursiveParamEnv: Env = new Map(env);
	const recursiveParams = carried.map((base) => bind(ctx, recursiveParamEnv, base));
	const tailParam = bind(ctx, recursiveParamEnv, "Tail");
	const elemParam = bind(ctx, recursiveParamEnv, stmt.name);
	// `tailParam` is captured directly (a JS closure variable), never looked up in `env` by a shared
	// key the way a real Core-level local is: it has no Core-level counterpart to be reassigned, and
	// a *nested* `forEach`'s own synthetic tail parameter would otherwise collide on that same key
	// name inside `env` — a real, fuzzer-found bug (`docs/targets/erlang.md`).
	const tailCall: Cont = (e) => {
		const args = [tailParam, ...carried.map((base) => resolveName(e, base))];
		return `${loopName}(${args.join(", ")})`;
	};
	const recursiveBody = compileStmts(ctx, recursiveParamEnv, stmt.body, 0, tailCall, onBreak, tailCall);
	const selfRef = selfReference(loopName, `${exhaustedBody}\n${recursiveBody}`);

	// Every parameter and pattern variable here is printed at its raw, minted spelling; an unused
	// one is left for `suppressUnusedBindings` to underscore in `printFunction`'s one finishing pass
	// over the whole function text — see that function's own doc for why a per-clause decision made
	// here, before dead-code elimination has even run, would be wrong (a fuzzer-found bug).
	return [
		`${loopName} = fun`,
		indent(
			[
				`${selfRef}([]${exhaustedParams.map((p) => `, ${p}`).join("")}) ->`,
				indent(exhaustedBody),
				`;`,
				`${selfRef}([${elemParam} | ${tailParam}]${recursiveParams.map((p) => `, ${p}`).join("")}) ->`,
				indent(recursiveBody),
			].join("\n"),
		),
		"end,",
		`${loopName}(${[iterableExpr, ...initialCarried].join(", ")})`,
	].join("\n");
}

/* ------------------------------------------------------------------ *
 * Functions and modules
 * ------------------------------------------------------------------ */

export function printFunction(fn: TFunc, moduleOf: ReadonlyMap<string, string>, constantNames: ReadonlySet<string> = new Set()): string {
	const ctx = newCtx(moduleOf, constantNames);
	const env: Env = new Map();
	const params = fn.params.map((param) => {
		const base = param.name === "env" ? "Env" : param.name;
		env.set(base, base);
		ctx.versions.set(base, 1);
		if (param.name === "env") env.set("env", "Env");
		// A top-level parameter is bound directly, not through `bind` (there is no fresh name to
		// mint — its spelling is fixed by the source signature), so it is added to `allBound` by
		// hand: `suppressUnusedBindings` below is the *only* place anything decides a name is
		// unused, over the signature and the body together, and every name has to be in that one
		// list for that to be true uniformly (see its own doc for why one finished-text pass, not a
		// decision made while a clause or the signature is still being built, is what a fuzzer-found
		// class of bug needs).
		ctx.allBound.push(base);
		return base;
	});
	const rawBody = compileStmts(ctx, env, fn.body, 0, unreachableCont(`${fn.name} fell through its own body`), undefined, undefined);
	const rawFull = `${fn.name}(${params.join(", ")}) ->\n${indent(rawBody)}.`;
	const full = suppressUnusedBindings(rawFull, ctx.allBound);
	const doc = fn.doc === undefined ? "" : `${fn.doc.split("\n").map((line) => `% ${line}`.trimEnd()).join("\n")}\n`;
	return `${doc}${full}`;
}

/**
 * Cross-module calls, computed from `module.imports` exactly the way every other target's own
 * qualification (Python's `from`, Rust's `use`) reads the same data — Erlang has no "import a bare
 * name" convention worth using (`-import/2` is a rarely-used, discouraged one), so a call to a
 * function this module does not define is spelled `module:fn(...)` instead.
 */
function moduleOfImports(module: TModule): ReadonlyMap<string, string> {
	const map = new Map<string, string>();
	for (const item of module.imports) {
		if (item.from === "SUPPORT" || item.from === "errors") continue;
		const atom = moduleAtom(item.from);
		for (const name of item.names) map.set(name, atom);
	}
	return map;
}

export function printRecord(record: TRecord): string {
	// Records are plain Erlang maps (see the module doc): nothing to declare, so this exists only
	// to document a record's shape for a reader, as a comment above the functions that build one.
	const doc = record.doc === undefined ? "" : `% ${record.doc.split("\n")[0]}\n`;
	const fields = record.fields.map((field) => `%   ${snake(field.name)}`).join("\n");
	return `${doc}% ${record.name} = #{\n${fields}\n%   }`;
}

export function printModule(module: TModule): string {
	const moduleOf = moduleOfImports(module);
	const atom = moduleAtom(module.path);
	const exported = module.functions.filter((fn) => fn.moduleExported);
	const arities = new Map<string, number>();
	for (const fn of module.functions) arities.set(fn.name, fn.params.length);
	const exportLine =
		exported.length === 0
			? ""
			: `-export([${exported.map((fn) => `${fn.name}/${arities.get(fn.name)}`).join(", ")}]).\n\n`;
	const records = module.records.map(printRecord).join("\n\n");
	// A hoisted constant table has nowhere else to live: Erlang has no module-level binding except a
	// function, so `hoistConstantTables`' `PascalCase` name (from `naming.value`, the same one every
	// local gets) becomes a zero-argument function, quoted because `PascalCase` is otherwise only
	// legal as a variable — see `Ctx.constantNames` and `constantRef`.
	const constantNames = new Set(module.constants.map((constant) => constant.name));
	const constants = module.constants
		.map((constant) => `'${constant.name}'() -> ${compileExpr(newCtx(moduleOf, constantNames), new Map(), constant.value)}.`)
		.join("\n\n");
	const functions = module.functions.map((fn) => printFunction(fn, moduleOf, constantNames)).join("\n\n");
	const parts = [module.header, "", `-module(${atom}).`, exportLine.trimEnd()];
	if (records !== "") parts.push("", records);
	if (constants !== "") parts.push("", constants);
	parts.push("", functions, "");
	return parts.filter((part) => part !== "").join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function importPath(_from: string, to: string): string {
	return to;
}

function renderType(type: SemType): string {
	switch (type.kind) {
		case "Bool":
			return "boolean()";
		case "Int":
		case "Decimal":
		case "CivilDate":
		case "Instant":
		case "Duration":
			return "integer()";
		case "Float":
			return "float()";
		case "String":
		case "Enum":
			return "binary()";
		case "List":
			return `[${renderType(type.elem)}]`;
		case "Option":
			return `{some, ${renderType(type.inner)}} | none`;
		case "Record":
			return "map()";
		case "Union":
			return "term()";
		case "Lambda":
			return `fun((${type.params.map(renderType).join(", ")}) -> ${renderType(type.ret)})`;
		case "Void":
			return "ok";
		case "Never":
			return "no_return()";
		default: {
			const exhaustive: never = type;
			return exhaustive;
		}
	}
}

/* ------------------------------------------------------------------ *
 * Support module: the capability record, the small helpers the table above calls by name, and
 * hand-written JSON, since OTP 25 (unlike OTP 27) ships none — see docs/targets/erlang.md.
 * ------------------------------------------------------------------ */

function supportModule(_program: CProgram, needs: SupportNeeds): { path: string; text: string } {
	const lines: string[] = [
		"% Code generated by the logic engine. DO NOT EDIT.",
		`% engine: ${ENGINE_VERSION}`,
		"% source: support",
		"",
		"-module(erl_support).",
		"-export([",
		"    erl_code_at/2, erl_char_at/2, erl_index_of/2, erl_starts_with/2, erl_ends_with/2,",
		"    erl_pad_start/3, erl_ascii_upper/1, erl_ascii_lower/1, erl_compare/2, erl_as_ascii/1,",
		"    erl_as_digits/1, erl_parse_digits/1, erl_at/2, erl_seq_index_of/2, erl_find/2,",
		"    erl_compare_ints/2, erl_date_from_epoch_days/1, erl_date_add_days/2, erl_retain/2,",
		"    erl_regex_test/2, erl_list_set/3" + (needs.race ? ", erl_race_first_some/1" : ""),
		"]).",
		"",
		"% The numeric value of the byte at Index, or `none` past the end (`str.codeAtOpt`).",
		"erl_code_at(Value, Index) ->",
		"    case Index >= 0 andalso Index < byte_size(Value) of",
		"        true -> {some, binary:at(Value, Index)};",
		"        false -> none",
		"    end.",
		"",
		"% The one-byte scalar at Index, or `none` past the end (`str.charAtOpt`).",
		"erl_char_at(Value, Index) ->",
		"    case Index >= 0 andalso Index < byte_size(Value) of",
		"        true -> {some, binary:part(Value, Index, 1)};",
		"        false -> none",
		"    end.",
		"",
		"% The byte offset of the first match, or -1 (`str.indexOf`).",
		"erl_index_of(Value, Needle) ->",
		"    case binary:match(Value, Needle) of",
		"        nomatch -> -1;",
		"        {Pos, _} -> Pos",
		"    end.",
		"",
		"erl_starts_with(Value, Prefix) ->",
		"    PrefixSize = byte_size(Prefix),",
		"    byte_size(Value) >= PrefixSize andalso binary:part(Value, 0, PrefixSize) =:= Prefix.",
		"",
		"erl_ends_with(Value, Suffix) ->",
		"    SuffixSize = byte_size(Suffix),",
		"    ValueSize = byte_size(Value),",
		"    ValueSize >= SuffixSize andalso binary:part(Value, ValueSize - SuffixSize, SuffixSize) =:= Suffix.",
		"",
		"% Pads Value on the left with Pad, repeated as needed, until it is Length scalars long.",
		"erl_pad_start(Value, Length, Pad) ->",
		"    Scalars = unicode:characters_to_list(Value, utf8),",
		"    Deficit = Length - length(Scalars),",
		"    case Deficit =< 0 of",
		"        true -> Value;",
		"        false ->",
		"            PadScalars = unicode:characters_to_list(Pad, utf8),",
		"            Prefix = erl_pad_take(PadScalars, PadScalars, Deficit),",
		"            unicode:characters_to_binary(Prefix ++ Scalars, utf8)",
		"    end.",
		"",
		"erl_pad_take(_Cycle, _Remaining, 0) -> [];",
		"erl_pad_take(Cycle, [], N) -> erl_pad_take(Cycle, Cycle, N);",
		"erl_pad_take(Cycle, [H | T], N) -> [H | erl_pad_take(Cycle, T, N - 1)].",
		"",
		"% Maps ASCII a-z to A-Z byte-wise, which is exact only when Value is proven ASCII.",
		"erl_ascii_upper(Value) ->",
		"    << <<(erl_upper_byte(B))>> || <<B>> <= Value >>.",
		"",
		"erl_upper_byte(B) when B >= $a, B =< $z -> B - 32;",
		"erl_upper_byte(B) -> B.",
		"",
		"erl_ascii_lower(Value) ->",
		"    << <<(erl_lower_byte(B))>> || <<B>> <= Value >>.",
		"",
		"erl_lower_byte(B) when B >= $A, B =< $Z -> B + 32;",
		"erl_lower_byte(B) -> B.",
		"",
		"% -1, 0 or 1: Erlang orders binaries byte by byte, which is code point order for UTF-8.",
		"erl_compare(A, B) when A < B -> -1;",
		"erl_compare(A, B) when A > B -> 1;",
		"erl_compare(_A, _B) -> 0.",
		"",
		"erl_compare_ints(A, B) when A < B -> -1;",
		"erl_compare_ints(A, B) when A > B -> 1;",
		"erl_compare_ints(_A, _B) -> 0.",
		"",
		"erl_as_ascii(Value) ->",
		"    case erl_all_bytes(Value, fun(B) -> B < 128 end) of",
		"        true -> {some, Value};",
		"        false -> none",
		"    end.",
		"",
		"erl_as_digits(Value) ->",
		"    case Value =/= <<>> andalso erl_all_bytes(Value, fun(B) -> B >= $0 andalso B =< $9 end) of",
		"        true -> {some, Value};",
		"        false -> none",
		"    end.",
		"",
		"erl_all_bytes(<<>>, _Test) -> true;",
		"erl_all_bytes(<<B, Rest/binary>>, Test) ->",
		"    case Test(B) of",
		"        true -> erl_all_bytes(Rest, Test);",
		"        false -> false",
		"    end.",
		"",
		"% An integer parsed from up to 18 ASCII digits, or `none` (`str.parseInt`).",
		"erl_parse_digits(Value) ->",
		"    case Value =/= <<>> andalso byte_size(Value) =< 18 andalso erl_all_bytes(Value, fun(B) -> B >= $0 andalso B =< $9 end) of",
		"        true -> {some, binary_to_integer(Value)};",
		"        false -> none",
		"    end.",
		"",
		"% The element at Index, or `none` past either end (`seq.at`).",
		"erl_at(Values, Index) ->",
		"    case Index >= 0 andalso Index < length(Values) of",
		"        true -> {some, lists:nth(Index + 1, Values)};",
		"        false -> none",
		"    end.",
		"",
		"erl_seq_index_of(Values, Needle) ->",
		"    case erl_index_1(Values, Needle, 0) of",
		"        {some, Index} -> Index;",
		"        none -> -1",
		"    end.",
		"",
		"erl_index_1([], _Needle, _At) -> none;",
		"erl_index_1([H | T], Needle, At) ->",
		"    case H =:= Needle of",
		"        true -> {some, At};",
		"        false -> erl_index_1(T, Needle, At + 1)",
		"    end.",
		"",
		"erl_find([], _Test) -> none;",
		"erl_find([H | T], Test) ->",
		"    case Test(H) of",
		"        true -> {some, H};",
		"        false -> erl_find(T, Test)",
		"    end.",
		"",
		"erl_date_from_epoch_days(Days) ->",
		"    case Days >= -719162 andalso Days =< 2932896 of",
		"        true -> {some, Days};",
		"        false -> none",
		"    end.",
		"",
		"erl_date_add_days(Days, Shift) -> erl_date_from_epoch_days(Days + Shift).",
		"",
		"% Drops every byte not in Class (a `[...]` character class), used only when the class is not",
		"% provably ASCII-only (the byte-wise comprehension in the capability table handles that case",
		"% without ever compiling a pattern). The general path still has to work for any class the",
		"% source language admits, so it goes through `re`.",
		"erl_retain(Class, Value) ->",
		"    Pattern = <<\"[\", (binary:part(Class, 1, byte_size(Class) - 2))/binary, \"]\">>,",
		"    {ok, Compiled} = re:compile(Pattern, [unicode, ucp]),",
		"    Scalars = unicode:characters_to_list(Value, utf8),",
		"    Kept = [S || S <- Scalars, re:run(unicode:characters_to_binary([S], utf8), Compiled, [{capture, none}]) =:= match],",
		"    unicode:characters_to_binary(Kept, utf8).",
		"",
		"% One compiled `re` pattern per distinct source string, cached in the process dictionary: the",
		"% pattern is known at code-generation time but `re:compile/2` is not free, and this project's",
		"% single-process differential driver calls the same validators many times over (the Go backend",
		"% hoists the same compile for the identical reason — see its own module comment).",
		"erl_regex_test(Pattern, Value) ->",
		"    Compiled =",
		"        case get({erl_regex, Pattern}) of",
		"            undefined ->",
		"                {ok, MP} = re:compile(Pattern, [unicode, ucp]),",
		"                put({erl_regex, Pattern}, MP),",
		"                MP;",
		"            MP -> MP",
		"        end,",
		"    re:run(Value, Compiled, [{capture, none}]) =:= match.",
		"",
		"% A new list with the element at Index replaced (`xs[i] = v`).",
		"erl_list_set(Values, Index, Value) ->",
		"    {Before, [_ | After]} = lists:split(Index, Values),",
		"    Before ++ [Value | After].",
		"",
	];
	if (needs.race) {
		lines.push(
			"% Runs idempotent tasks concurrently (one process per task) and answers the first `{some,",
			"% _}` result, or `none` once every task has answered `none`. Cancellation is best effort: a",
			"% losing process may run to completion, and its answer is dropped, unread.",
			"erl_race_first_some(Tasks) ->",
			"    Parent = self(),",
			"    Pids = [spawn(fun() -> Parent ! {self(), Task()} end) || Task <- Tasks],",
			"    erl_race_collect(Pids).",
			"",
			"erl_race_collect([]) -> none;",
			"erl_race_collect(Pids) ->",
			"    receive",
			"        {Pid, {some, Value}} ->",
			"            [exit(P, kill) || P <- Pids, P =/= Pid],",
			"            {some, Value};",
			"        {_Pid, none} = Msg ->",
			"            {_Pid2, none} = Msg,",
			"            erl_race_collect(Pids -- [element(1, Msg)])",
			"    end.",
			"",
		);
	}
	if (needs.env) {
		lines.push(
			"% Capabilities is a map of closures: request/1, now/0, sleep/1, next_u32/0 — see",
			"% docs/targets/erlang.md for why a map of funs stands in for an interface here.",
			"% An HttpRequest/HttpResponse/HttpHeader is the same shape, as a plain map:",
			"%   #{method => Binary, url => Binary, headers => [#{name => Binary, value => Binary}],",
			"%     body => Binary, timeout_millis => Integer}",
			"%   #{status => Integer, headers => [...], body => Binary}",
			"",
		);
	}
	return { path: "erl_support.erl", text: lines.join("\n") };
}

function errorsModule(program: CProgram): { path: string; text: string } | undefined {
	const declared = [...program.errors.values()];
	if (declared.length === 0) return undefined;
	// Domain errors are represented as `{ErrorTag, Message}` tuples (see the module doc), and an
	// atom needs no declaration to exist in Erlang, so there is nothing to generate here beyond a
	// reference a reviewer can check the capability table's tags against.
	const lines = [
		"% Code generated by the logic engine. DO NOT EDIT.",
		`% engine: ${ENGINE_VERSION}`,
		"% source: errors",
		"%",
		"% Every domain error is `{ErrorTag, Message}` where ErrorTag is one of:",
		...declared.map((error) => `%   ${snake(error.name)}${error.base === undefined ? "" : ` (extends ${snake(error.base)})`}`),
	];
	return { path: "errors.erl.txt", text: `${lines.join("\n")}\n` };
}

/* ------------------------------------------------------------------ *
 * The differential driver: a hand-written JSON codec (OTP 25 ships none — `json` only arrived in
 * OTP 27) plus dispatch by function name, speaking the same `{"fn":…,"args":[…]}` /
 * `{"ok":…,"value"|"error":…}` line protocol as every other target's driver.
 * ------------------------------------------------------------------ */

function driverFiles(program: CProgram, entries: readonly DriverEntry[]): { path: string; text: string }[] {
	const moduleOf = (path: string): string => moduleAtom(path);

	/** Converts a decoded JSON value (see `json_decode` below) into the shape a generated function expects. */
	const value = (type: SemType, expr: string): string => {
		switch (type.kind) {
			case "Bool":
				return expr;
			case "Int":
			case "Decimal":
			case "CivilDate":
			case "Instant":
			case "Duration":
				return `erlang:trunc(${expr})`;
			case "Float":
				return expr;
			case "String":
			case "Enum":
				return expr;
			case "List":
				return `[${value(type.elem, "__item")} || __item <- ${expr}]`;
			case "Record": {
				const definition = program.records.get(type.name);
				const fields = (definition?.fields ?? [])
					.map((field) => `${snake(field.name)} => ${value(field.type, `maps:get(${erlString(field.name)}, ${expr})`)}`)
					.join(", ");
				return `#{${fields}}`;
			}
			case "Option":
				return `(case ${expr} of null -> none; __present -> {some, ${value(type.inner, "__present")}} end)`;
			default:
				return expr;
		}
	};

	/** The inverse: a generated function's answer back into the plain JSON-able shape. */
	const encode = (type: SemType, expr: string): string => {
		switch (type.kind) {
			case "List":
				return `[${encode(type.elem, "__item")} || __item <- ${expr}]`;
			case "Option":
				return `(case ${expr} of none -> null; {some, __inner} -> ${encode(type.inner, "__inner")} end)`;
			case "Record": {
				const definition = program.records.get(type.name);
				const fields = (definition?.fields ?? [])
					.map((field) => `${erlString(field.name)} => ${encode(field.type, `maps:get(${snake(field.name)}, ${expr})`)}`)
					.join(", ");
				return `#{${fields}}`;
			}
			default:
				return expr;
		}
	};

	const needsEnv = entries.some((entry) => entry.usesEnv);

	const cases = entries.map((entry, index) => {
		const args = entry.params
			.map((param, paramIndex) => value(param, `lists:nth(${paramIndex + 1}, Args)`))
			.concat(entry.usesEnv ? ["Environment"] : []);
		const call = `${moduleOf(entry.modulePath)}:${entry.targetName}(${args.join(", ")})`;
		if (entry.fails.length > 0) {
			return [
				`        ${erlString(entry.coreName)} ->`,
				`            case ${call} of`,
				`                {__ok_value, nil} -> {ok, ${encode(entry.ret, "__ok_value")}};`,
				`                {_, {ErrorTag, _Message}} -> {error, atom_to_binary(ErrorTag, utf8)}`,
				"            end;",
			].join("\n");
		}
		return `        ${erlString(entry.coreName)} -> {ok, ${encode(entry.ret, call)}};`;
	});

	const lines: string[] = [
		"% Code generated by the logic engine. DO NOT EDIT.",
		"% source: _driver",
		"",
		"-module(driver).",
		"-export([main/1]).",
		"",
		"dispatch(Name, Args" + (needsEnv ? ", Environment" : "") + ") ->",
		"    case Name of",
		...cases,
		'        _ -> {error, <<"unknown function">>}',
		"    end.",
		"",
	];

	if (needsEnv) {
		lines.push(
			"% The reference PCG32: same constants and default seed as the interpreter's, so a draw",
			"% matches bit for bit. A fresh generator is built per request, the same way the reference",
			"% model starts a fresh interpreter, and so a fresh generator, per case.",
			// Mirrors the reference's own `newPcg32` exactly: state starts at 0, one *state
			// transition* (not a full `next()` — the value it would have produced is never read)
			// folds in the increment, the seed is added, and a second transition follows. Go's own
			// driver gets this by literally calling `next()` twice around the `+= seed` and
			// discarding both return values; this does the same two transitions directly, since
			// discarding a value there would otherwise need a value nothing else in this file needs.
			"pcg32_new(Seed) ->",
			"    S1 = (0 * 6364136223846793005 + 1442695040888963407) band 16#FFFFFFFFFFFFFFFF,",
			"    S2 = (S1 + Seed) band 16#FFFFFFFFFFFFFFFF,",
			"    (S2 * 6364136223846793005 + 1442695040888963407) band 16#FFFFFFFFFFFFFFFF.",
			"",
			"pcg32_next(State) ->",
			"    NewState = (State * 6364136223846793005 + 1442695040888963407) band 16#FFFFFFFFFFFFFFFF,",
			"    Xorshifted = (((State bsr 18) bxor State) bsr 27) band 16#FFFFFFFF,",
			"    Rotation = State bsr 59,",
			"    Value = ((Xorshifted bsr Rotation) bor (Xorshifted bsl ((-Rotation) band 31))) band 16#FFFFFFFF,",
			"    {Value, NewState}.",
			"",
			"-define(DEFAULT_SEED, 16#853c49e6748fea9b).",
			"",
			"% The capability fake the differential harness drives: responses come from fixtures.json, a",
			"% URL that is missing models a transport error, and the scripted latency is what decides a",
			"% race — see `erl_support:erl_race_first_some/1`.",
			"new_environment(Fixtures) ->",
			"    RandomState = pcg32_new(?DEFAULT_SEED),",
			"    RandomRef = spawn(fun() -> random_loop(RandomState) end),",
			"    #{",
			"        request => fun(Request) -> fake_request(Fixtures, Request) end,",
			"        now => fun() -> 0 end,",
			"        sleep => fun(Millis) -> timer:sleep(Millis) end,",
			"        next_u32 => fun() -> RandomRef ! {self(), next}, receive {RandomRef, V} -> V end end",
			"    }.",
			"",
			"random_loop(State) ->",
			"    receive",
			"        {From, next} ->",
			"            {Value, NewState} = pcg32_next(State),",
			"            From ! {self(), Value},",
			"            random_loop(NewState)",
			"    end.",
			"",
			"fake_request(Fixtures, Request) ->",
			"    Url = maps:get(url, Request),",
			"    case maps:find(Url, Fixtures) of",
			"        error -> none;",
			"        {ok, Fixture} ->",
			"            timer:sleep(maps:get(<<\"latencyMillis\">>, Fixture, 0)),",
			"            {some, #{",
			"                status => maps:get(<<\"status\">>, Fixture),",
			"                headers => [],",
			"                body => maps:get(<<\"body\">>, Fixture)",
			"            }}",
			"    end.",
			"",
			"load_fixtures() ->",
			"    case file:read_file(\"fixtures.json\") of",
			"        {ok, Bin} -> json_decode(Bin);",
			"        {error, _} -> #{}",
			"    end.",
			"",
		);
	}

	lines.push(
		"main(_Args) ->",
		needsEnv ? "    Fixtures = load_fixtures()," : "",
		"    loop(" + (needsEnv ? "Fixtures" : "") + ").",
		"",
		"loop(" + (needsEnv ? "Fixtures" : "") + ") ->",
		"    case io:get_line(\"\") of",
		"        eof -> ok;",
		'        "\\n" -> loop(' + (needsEnv ? "Fixtures" : "") + ");",
		"        Line ->",
		// `io:get_line` reads `standard_io` in its default (`latin1`/byte) mode, so `Line` is a list
		// of the *raw bytes* of one already-UTF-8-encoded input line, not a list of decoded scalars —
		// `list_to_binary/1` packs each one back as a byte. `unicode:characters_to_binary(Line, utf8)`
		// looks like the right call here and is not: it treats `Line` as scalars and UTF-8-encodes
		// them again, which is only invisible for pure ASCII and silently doubles every UTF-8-encoded
		// byte of a multi-byte scalar (e.g. ` `'s `0xC2 0xA0`) into four bytes.
		"            Request = json_decode(list_to_binary(Line)),",
		'            Fn = maps:get(<<"fn">>, Request),',
		'            Args = maps:get(<<"args">>, Request),',
		needsEnv ? "            Environment = new_environment(Fixtures)," : "",
		"            Result =",
		needsEnv
			? "                try dispatch(Fn, Args, Environment) catch _:_ -> {error, <<\"exception\">>} end,"
			: "                try dispatch(Fn, Args) catch _:_ -> {error, <<\"exception\">>} end,",
		"            Out =",
		"                case Result of",
		'                    {ok, Value} -> json_encode(#{<<"ok">> => true, <<"value">> => Value});',
		'                    {error, Error} -> json_encode(#{<<"ok">> => false, <<"error">> => Error})',
		"                end,",
		"            io:format(\"~s~n\", [Out]),",
		"            loop(" + (needsEnv ? "Fixtures" : "") + ")",
		"    end.",
		"",
		"% ---- A minimal JSON codec: OTP 25 ships no `json` module (that arrived in OTP 27). The",
		"% ---- protocol only ever carries numbers, booleans, strings, arrays and flat-ish objects, so",
		"% ---- this does not need to be a general-purpose parser, only a correct one for that shape.",
		"",
		"json_decode(Bin) ->",
		"    {Value, Rest} = json_value(json_skip_ws(Bin)),",
		"    _ = json_skip_ws(Rest),",
		"    Value.",
		"",
		"json_skip_ws(<<C, Rest/binary>>) when C =:= $\\s; C =:= $\\t; C =:= $\\n; C =:= $\\r -> json_skip_ws(Rest);",
		"json_skip_ws(Bin) -> Bin.",
		"",
		'json_value(<<"null", Rest/binary>>) -> {null, Rest};',
		'json_value(<<"true", Rest/binary>>) -> {true, Rest};',
		'json_value(<<"false", Rest/binary>>) -> {false, Rest};',
		'json_value(<<$", Rest/binary>>) -> json_string(Rest, []);',
		"json_value(<<$[, Rest/binary>>) -> json_array(json_skip_ws(Rest), []);",
		"json_value(<<${, Rest/binary>>) -> json_object(json_skip_ws(Rest), #{});",
		"json_value(Bin) -> json_number(Bin, []).",
		"",
		'json_string(<<$", Rest/binary>>, Acc) -> {unicode:characters_to_binary(lists:reverse(Acc), utf8), Rest};',
		'json_string(<<$\\\\, $", Rest/binary>>, Acc) -> json_string(Rest, [$" | Acc]);',
		'json_string(<<$\\\\, $\\\\, Rest/binary>>, Acc) -> json_string(Rest, [$\\\\ | Acc]);',
		'json_string(<<$\\\\, $/, Rest/binary>>, Acc) -> json_string(Rest, [$/ | Acc]);',
		'json_string(<<$\\\\, $n, Rest/binary>>, Acc) -> json_string(Rest, [$\\n | Acc]);',
		'json_string(<<$\\\\, $t, Rest/binary>>, Acc) -> json_string(Rest, [$\\t | Acc]);',
		'json_string(<<$\\\\, $r, Rest/binary>>, Acc) -> json_string(Rest, [$\\r | Acc]);',
		'json_string(<<$\\\\, $b, Rest/binary>>, Acc) -> json_string(Rest, [$\\b | Acc]);',
		'json_string(<<$\\\\, $f, Rest/binary>>, Acc) -> json_string(Rest, [$\\f | Acc]);',
		'json_string(<<$\\\\, $u, H1, H2, H3, H4, Rest/binary>>, Acc) ->',
		"    Code = list_to_integer([H1, H2, H3, H4], 16),",
		"    json_string(Rest, [Code | Acc]);",
		"json_string(<<C/utf8, Rest/binary>>, Acc) -> json_string(Rest, [C | Acc]).",
		"",
		"json_number(<<C, Rest/binary>>, Acc) when (C >= $0 andalso C =< $9); C =:= $-; C =:= $+; C =:= $.; C =:= $e; C =:= $E ->",
		"    json_number(Rest, [C | Acc]);",
		"json_number(Rest, Acc) ->",
		"    Text = lists:reverse(Acc),",
		"    Value =",
		"        case lists:member($., Text) orelse lists:member($e, Text) orelse lists:member($E, Text) of",
		"            true -> list_to_float(Text);",
		"            false -> list_to_integer(Text)",
		"        end,",
		"    {Value, Rest}.",
		"",
		"json_array(<<$], Rest/binary>>, Acc) -> {lists:reverse(Acc), Rest};",
		"json_array(Bin, Acc) ->",
		"    {Value, Rest} = json_value(json_skip_ws(Bin)),",
		"    case json_skip_ws(Rest) of",
		"        <<$,, Rest2/binary>> -> json_array(json_skip_ws(Rest2), [Value | Acc]);",
		"        <<$], Rest2/binary>> -> {lists:reverse([Value | Acc]), Rest2}",
		"    end.",
		"",
		"json_object(<<$}, Rest/binary>>, Acc) -> {Acc, Rest};",
		"json_object(Bin, Acc) ->",
		'    <<$", Rest0/binary>> = Bin,',
		"    {Key, Rest1} = json_string(Rest0, []),",
		"    <<$:, Rest2/binary>> = json_skip_ws(Rest1),",
		"    {Value, Rest3} = json_value(json_skip_ws(Rest2)),",
		"    NewAcc = maps:put(Key, Value, Acc),",
		"    case json_skip_ws(Rest3) of",
		"        <<$,, Rest4/binary>> -> json_object(json_skip_ws(Rest4), NewAcc);",
		"        <<$}, Rest4/binary>> -> {NewAcc, Rest4}",
		"    end.",
		"",
		"json_encode(null) -> <<\"null\">>;",
		"json_encode(true) -> <<\"true\">>;",
		"json_encode(false) -> <<\"false\">>;",
		"json_encode(V) when is_integer(V) -> integer_to_binary(V);",
		"json_encode(V) when is_float(V) -> float_to_binary(V, [short]);",
		"json_encode(V) when is_binary(V) -> json_encode_string(V);",
		"json_encode(V) when is_list(V) -> <<$[, (json_encode_join([json_encode(I) || I <- V])) /binary, $]>>;",
		"json_encode(V) when is_map(V) ->",
		"    Pairs = [<<(json_encode_string(K))/binary, $:, (json_encode(Val))/binary>> || {K, Val} <- maps:to_list(V)],",
		"    <<${, (json_encode_join(Pairs))/binary, $}>>.",
		"",
		"json_encode_join([]) -> <<>>;",
		"json_encode_join([H]) -> H;",
		"json_encode_join([H | T]) -> <<H/binary, $,, (json_encode_join(T))/binary>>.",
		"",
		"json_encode_string(Bin) ->",
		"    <<$\", (json_escape(Bin))/binary, $\">>.",
		"",
		"json_escape(<<>>) -> <<>>;",
		'json_escape(<<$", Rest/binary>>) -> <<"\\\\\\"", (json_escape(Rest))/binary>>;',
		'json_escape(<<$\\\\, Rest/binary>>) -> <<"\\\\\\\\", (json_escape(Rest))/binary>>;',
		'json_escape(<<$\\n, Rest/binary>>) -> <<"\\\\n", (json_escape(Rest))/binary>>;',
		'json_escape(<<$\\r, Rest/binary>>) -> <<"\\\\r", (json_escape(Rest))/binary>>;',
		'json_escape(<<$\\t, Rest/binary>>) -> <<"\\\\t", (json_escape(Rest))/binary>>;',
		"json_escape(<<C/utf8, Rest/binary>>) when C < 16#20 ->",
		'    Hex = list_to_binary(io_lib:format("~4.16.0b", [C])),',
		'    <<"\\\\u", Hex/binary, (json_escape(Rest))/binary>>;',
		"json_escape(<<C/utf8, Rest/binary>>) -> <<C/utf8, (json_escape(Rest))/binary>>.",
		"",
	);

	// `escript`'s own shebang comment (`%%!`) is how it takes extra emulator flags; `-pa .` puts the
	// already-`erlc`-compiled `.beam` files next to this script on the code path, so `escript` never
	// recompiles anything — it only ever loads what `erlc` already built.
	const escript = ["#!/usr/bin/env escript", "%%! -pa .", "", "main(_Args) ->", "    driver:main([])."].join("\n");

	return [
		{ path: "driver.erl", text: lines.filter((line) => line !== "").join("\n") },
		{ path: "run_driver.escript", text: `${escript}\n` },
	];
}

export const ERLANG_BACKEND: Backend = {
	spec: ERLANG_SPEC,
	fileExtension: ERLANG_CONFIG.fileExtension,
	printModule,
	importPath,
	support: supportModule,
	errorsModule,
	renderType,
	comment: "%",
	driver: driverFiles,
	supportImport: () => [],
};
