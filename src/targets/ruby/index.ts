/**
 * The Ruby backend.
 *
 * Ruby 3.2+ (the installed toolchain is 3.3.6), standard library only. Every generated file
 * reopens the same top-level `module Core`, so a function defined in one file can call a sibling
 * defined in another with a bare, unqualified name — Ruby resolves it through `self` the same way
 * a hand written module full of `def self.foo` methods would, which is also what keeps this
 * backend from needing per-call name qualification the way a namespaced language would. Integers
 * are Ruby's `Integer`, already arbitrary precision, so a proven range never forces a different
 * representation here, exactly as for Python. Records are `Data.define` value objects (Ruby 3.2+):
 * immutable, with structural `==` and a `#to_h` the driver uses to serialize them.
 *
 * See `docs/targets/ruby.md` for the representation table and the decisions specific to this
 * target — most notably that Ruby's own `String#[]`/`#index`/`#<=>` are already scalar
 * (code-point) based, which is stronger than Python needs and lets several lowerings here go
 * unconditional where Python's stay ASCII-gated.
 */

import { dirname, relative as relativePath } from "node:path";
import type { Backend, DriverEntry, SupportNeeds } from "../../backend/generate.ts";
import { ENGINE_VERSION } from "../../backend/generate.ts";
import type { TargetSpec } from "../../backend/lower.ts";
import type { Candidate } from "../../backend/select.ts";
import { LoweringTable, argIsAscii } from "../../backend/select.ts";
import type { TExpr, TFunc, TModule, TRecord, TStmt } from "../../backend/tast.ts";
import type { CProgram } from "../../core/ir.ts";
import { printRegex } from "../../regex.ts";
import type { SemType } from "../../types.ts";
import type { Value } from "../../values.ts";
import { TRIM_CODE_POINTS } from "../../intrinsics/index.ts";

export const RUBY_CONFIG = {
	baseline: "Ruby 3.2",
	fileExtension: ".rb",
	moduleName: "Core",
	dependencies: [] as string[],
	formatter: "standardrb --fix",
	linters: ["standardrb"],
};

/** A descriptive type string for `API.json`. Ruby itself needs no annotation anywhere. */
export function rubyType(type: SemType): string {
	switch (type.kind) {
		case "Bool":
			return "Boolean";
		case "Int":
		case "Decimal":
		case "CivilDate":
		case "Instant":
		case "Duration":
			return "Integer";
		case "Float":
			return "Float";
		case "String":
			return "String";
		case "List":
			return `Array<${rubyType(type.elem)}>`;
		case "Option":
			return `${rubyType(type.inner)}?`;
		case "Record":
			return type.name;
		case "Enum":
			return type.members.map((member) => JSON.stringify(member)).join(" | ");
		case "Union":
			return type.name;
		case "Lambda":
			return "Proc";
		case "Void":
			return "nil";
		case "Never":
			return "NoReturn";
		default: {
			const exhaustive: never = type;
			return exhaustive;
		}
	}
}

const raw = (text: string): TExpr => ({ kind: "raw", text });

/** The sentinel every checked lowering's absent branch prints as, compared by reference below. */
const NIL = raw("nil");

/** `value ? test : nil`, the shape every checked lowering takes in Ruby. */
function checked(value: string, test: string): TExpr {
	return { kind: "ternary", test: raw(test), then: raw(value), otherwise: NIL };
}

/**
 * The name a checked lowering's own value is bound to when `opt.orElse` cannot fuse into it and
 * the value is not already a bare name/literal/member — an arbitrary expression would otherwise
 * be evaluated twice, once for the nil test and once for the answer.
 */
// Not underscore-prefixed: that prefix is Ruby's own convention for a deliberately unused
// variable, and standardrb's `Lint/UnderscorePrefixedVariableName` flags this one precisely
// because it *is* read, right after it is bound.
const ORELSE_TEMP = "or_else_value";

function binary(op: string): Candidate["emit"] {
	return (args) => ({ kind: "binary", op, left: args[0]!, right: args[1]! });
}

const cheap = { alloc: "none", time: "constant" } as const;
const linear = { alloc: "none", time: "linear" } as const;
const allocating = { alloc: "one", time: "linear" } as const;

function nonNegative(index: number) {
	return (args: readonly SemType[]): boolean => {
		const arg = args[index];
		return arg !== undefined && arg.kind === "Int" && arg.lo >= 0n;
	};
}

/** A lambda rendered as a Ruby block attached to the preceding method call. */
function blockOf(lambda: TExpr): string {
	if (lambda.kind !== "lambda") return `{ |__item| ${print(lambda)}.call(__item) }`;
	const params = lambda.params.map((param) => param.name).join(", ");
	if (lambda.body.length === 1 && lambda.body[0]!.kind === "return" && lambda.body[0]!.value !== undefined) {
		return `{ |${params}| ${print(lambda.body[0]!.value!)} }`;
	}
	return `{ |${params}|\n${printBody(lambda.body, 1)}\n}`;
}

export const RUBY_CANDIDATES: readonly Candidate[] = [
	...["add:+", "sub:-", "mul:*"].map((entry) => {
		const [op, symbol] = entry.split(":") as [string, string];
		return { op: `int.${op}`, impl: "native" as const, cost: cheap, emit: binary(symbol) };
	}),
	...["add:+", "sub:-", "mul:*", "div:/"].map((entry) => {
		const [op, symbol] = entry.split(":") as [string, string];
		return { op: `float.${op}`, impl: "native" as const, cost: cheap, emit: binary(symbol) };
	}),
	{
		op: "int.div",
		impl: "native",
		requires: (args) => nonNegative(0)(args) && nonNegative(1)(args),
		because: "Ruby's `/` floors, so it only matches truncated division when both operands are non-negative",
		cost: cheap,
		emit: binary("/"),
	},
	{
		op: "int.div",
		impl: "library",
		cost: cheap,
		deps: ["_support"],
		emit: (args, _types, ctx) => {
			ctx.require("_support");
			return raw(`trunc_div(${print(args[0]!)}, ${print(args[1]!)})`);
		},
	},
	{
		op: "int.mod",
		impl: "native",
		requires: (args) => nonNegative(0)(args) && nonNegative(1)(args),
		because: "Ruby's `%` is floored, so it only matches the Core's truncated remainder for non-negative operands",
		cost: cheap,
		emit: binary("%"),
	},
	{
		op: "int.mod",
		impl: "library",
		cost: cheap,
		deps: ["_support"],
		emit: (args, _types, ctx) => {
			ctx.require("_support");
			return raw(`trunc_mod(${print(args[0]!)}, ${print(args[1]!)})`);
		},
	},
	{ op: "int.neg", impl: "native", cost: cheap, emit: (args) => raw(`-${print(args[0]!)}`) },
	{ op: "float.neg", impl: "native", cost: cheap, emit: (args) => raw(`-${print(args[0]!)}`) },
	{ op: "int.abs", impl: "native", cost: cheap, emit: (args) => raw(`${print(args[0]!)}.abs`) },
	{
		op: "int.min",
		impl: "native",
		cost: cheap,
		because: "`int.min(int.max(x, lo), hi)` -- exactly the shape a clamped range check compiles to -- is `x.clamp(lo, hi)`, which is also what standardrb's Style/ComparableClamp already insists on",
		emit: (args) => {
			const left = args[0]!;
			const right = print(args[1]!);
			const clamped = left.kind === "raw" ? /^\[(.+), (.+)\]\.max$/.exec(left.text) : null;
			if (clamped !== null) return raw(`${clamped[1]}.clamp(${clamped[2]}, ${right})`);
			return raw(`[${print(left)}, ${right}].min`);
		},
	},
	{ op: "int.max", impl: "native", cost: cheap, emit: (args) => raw(`[${print(args[0]!)}, ${print(args[1]!)}].max`) },
	...["lt:<", "le:<=", "gt:>", "ge:>="].flatMap((entry) => {
		const [op, symbol] = entry.split(":") as [string, string];
		return [
			{ op: `int.${op}`, impl: "native" as const, cost: cheap, emit: binary(symbol) },
			{ op: `float.${op}`, impl: "native" as const, cost: cheap, emit: binary(symbol) },
		];
	}),
	{ op: "float.fromInt", impl: "native", cost: cheap, emit: (args) => raw(`${print(args[0]!)}.to_f`) },
	{ op: "core.eq", impl: "native", cost: cheap, emit: binary("==") },

	{ op: "opt.isNone", impl: "native", cost: cheap, emit: (args) => raw(`${print(args[0]!)}.nil?`) },
	{ op: "opt.unwrap", impl: "native", cost: cheap, emit: (args) => args[0]! },
	{ op: "opt.some", impl: "native", cost: cheap, emit: (args) => args[0]! },
	{
		op: "opt.orElse",
		impl: "native",
		cost: cheap,
		emit: (args, types) => {
			const value = args[0]!;
			// A checked lowering already answers `value ? test : nil`, so the default belongs in
			// that `else` branch: the test runs once, and the result reads the way a Ruby author
			// would have written it. Only while the value itself can never be nil, which an Option
			// of an Option would break.
			if (value.kind === "ternary" && value.otherwise === NIL && types[0]?.kind === "Option" && types[0].inner.kind !== "Option") {
				return { kind: "ternary", test: value.test, then: value.then, otherwise: args[1]! };
			}
			// A bare name, literal or field read is already side-effect free and cheap to repeat,
			// so no temporary is needed; anything else is bound once so it is evaluated only once.
			if (value.kind === "name" || value.kind === "lit" || value.kind === "member") {
				return raw(`(${print(value)}.nil? ? ${print(args[1]!)} : ${print(value)})`);
			}
			return raw(`(${ORELSE_TEMP} = ${print(value)}; ${ORELSE_TEMP}.nil? ? ${print(args[1]!)} : ${ORELSE_TEMP})`);
		},
	},

	{
		op: "str.len",
		impl: "native",
		because: "`#length` counts Unicode scalars for a UTF-8 string, which is the Core's definition",
		cost: cheap,
		emit: (args) => raw(`${print(args[0]!)}.length`),
	},
	{ op: "str.concat", impl: "native", cost: allocating, emit: binary("+") },
	{
		op: "str.codeAt",
		impl: "native",
		requires: argIsAscii(0),
		cost: cheap,
		because:
			"Ruby's own `[]` is already scalar-indexed for any string, but the frontend only ever offers this op an ASCII-proven argument (`docs/semantics.md` \u00a72.3), so the precondition documents that shared rule rather than a Ruby-specific limitation",
		emit: (args) => raw(`${print(args[0]!)}[${print(args[1]!)}].ord`),
	},
	{
		op: "str.charAt",
		impl: "native",
		requires: argIsAscii(0),
		cost: cheap,
		emit: (args) => raw(`${print(args[0]!)}[${print(args[1]!)}]`),
	},
	{
		op: "str.codeAtOpt",
		impl: "native",
		requires: argIsAscii(0),
		cost: cheap,
		emit: (args) =>
			checked(
				`${print(args[0]!)}[${print(args[1]!)}].ord`,
				`${print(args[1]!)} >= 0 && ${print(args[1]!)} < ${print(args[0]!)}.length`,
			),
	},
	{
		op: "str.charAtOpt",
		impl: "native",
		requires: argIsAscii(0),
		cost: cheap,
		emit: (args) =>
			checked(
				`${print(args[0]!)}[${print(args[1]!)}]`,
				`${print(args[1]!)} >= 0 && ${print(args[1]!)} < ${print(args[0]!)}.length`,
			),
	},
	{
		op: "str.slice",
		impl: "library",
		requires: argIsAscii(0),
		because:
			"Ruby's `String#[]` answers nil, not an empty string, when the start of a range is past the string's length, so a total slice needs the explicit clamp `str_slice` gives it",
		cost: allocating,
		deps: ["_support"],
		emit: (args, _types, ctx) => {
			ctx.require("_support");
			return raw(`str_slice(${print(args[0]!)}, ${print(args[1]!)}, ${print(args[2]!)})`);
		},
	},
	{
		op: "str.indexOf",
		impl: "native",
		because: "`String#index` answers a scalar (code point) offset for any string, not a byte or UTF-16 offset",
		cost: linear,
		emit: (args) => raw(`(${print(args[0]!)}.index(${print(args[1]!)}) || -1)`),
	},
	{ op: "str.contains", impl: "native", cost: linear, emit: (args) => raw(`${print(args[0]!)}.include?(${print(args[1]!)})`) },
	{ op: "str.startsWith", impl: "native", cost: linear, emit: (args) => raw(`${print(args[0]!)}.start_with?(${print(args[1]!)})`) },
	{ op: "str.endsWith", impl: "native", cost: linear, emit: (args) => raw(`${print(args[0]!)}.end_with?(${print(args[1]!)})`) },
	{ op: "str.repeat", impl: "native", cost: allocating, emit: binary("*") },
	{ op: "str.padStart", impl: "native", cost: allocating, emit: (args) => raw(`${print(args[0]!)}.rjust(${print(args[1]!)}, ${print(args[2]!)})`) },
	{
		op: "str.trim",
		impl: "native",
		because: "Ruby's `#strip` uses its own fixed whitespace set, so the 25 code points are matched explicitly",
		cost: allocating,
		emit: (args) => {
			const body = trimClassBody();
			return raw(`${print(args[0]!)}.gsub(Regexp.new(${rubyString(`\\A[${body}]+|[${body}]+\\z`)}), "")`);
		},
	},
	{
		op: "str.asciiUpper",
		impl: "native",
		because:
			"`String#tr` translates character by character with no folding table, so `tr('a-z', 'A-Z')` maps only a-z and leaves every other scalar alone -- proven ASCII or not -- in one pass, unlike a host case method that would need Unicode folding on anything wider",
		cost: allocating,
		emit: (args) => raw(`${print(args[0]!)}.tr("a-z", "A-Z")`),
	},
	{
		op: "str.asciiLower",
		impl: "native",
		because: "the same one-pass transliteration as `str.asciiUpper`, mapping A-Z only",
		cost: allocating,
		emit: (args) => raw(`${print(args[0]!)}.tr("A-Z", "a-z")`),
	},
	{
		op: "str.compare",
		impl: "native",
		because: "Ruby's `<=>` compares UTF-8 strings byte by byte, which agrees with code point order, and already answers -1/0/1",
		cost: linear,
		emit: (args) => raw(`(${print(args[0]!)} <=> ${print(args[1]!)})`),
	},
	{ op: "str.codePoints", impl: "native", cost: allocating, emit: (args) => raw(`${print(args[0]!)}.codepoints`) },
	{ op: "str.fromCodePoints", impl: "native", cost: allocating, emit: (args) => raw(`${print(args[0]!)}.pack("U*")`) },
	{ op: "str.asAscii", impl: "native", cost: linear, emit: (args) => checked(print(args[0]!), `${print(args[0]!)}.ascii_only?`) },
	{
		op: "str.asDigits",
		impl: "native",
		cost: linear,
		emit: (args) => checked(print(args[0]!), `${print(args[0]!)}.match?(/\\A[0-9]+\\z/)`),
	},
	{
		op: "str.split",
		impl: "library",
		because: "Ruby's `#split` drops trailing empty fields by default (and answers `[]`, not `[\"\"]`, for an empty receiver), so an explicit helper keeps every field the Core expects",
		cost: allocating,
		deps: ["_support"],
		emit: (args, _types, ctx) => {
			ctx.require("_support");
			return raw(`str_split(${print(args[0]!)}, ${print(args[1]!)})`);
		},
	},
	{ op: "str.join", impl: "native", cost: allocating, emit: (args) => raw(`${print(args[0]!)}.join(${print(args[1]!)})`) },
	{ op: "str.fromInt", impl: "native", cost: allocating, emit: (args) => raw(`${print(args[0]!)}.to_s`) },
	{
		op: "str.parseInt",
		impl: "native",
		cost: linear,
		emit: (args) =>
			checked(
				`${print(args[0]!)}.to_i`,
				`!${print(args[0]!)}.empty? && ${print(args[0]!)}.length <= 18 && ${print(args[0]!)}.match?(/\\A[0-9]+\\z/)`,
			),
	},

	{ op: "seq.len", impl: "native", cost: cheap, emit: (args) => raw(`${print(args[0]!)}.length`) },
	{ op: "seq.get", impl: "native", cost: cheap, emit: (args) => raw(`${print(args[0]!)}[${print(args[1]!)}]`) },
	{
		op: "seq.at",
		impl: "native",
		cost: cheap,
		emit: (args) =>
			checked(
				`${print(args[0]!)}[${print(args[1]!)}]`,
				`${print(args[1]!)} >= 0 && ${print(args[1]!)} < ${print(args[0]!)}.length`,
			),
	},
	{ op: "seq.push", impl: "native", cost: cheap, emit: (args) => raw(`${print(args[0]!)}.push(${print(args[1]!)})`) },
	{ op: "seq.map", impl: "native", because: "`#map` with a block is the idiomatic map", cost: allocating, emit: (args) => raw(`${print(args[0]!)}.map ${blockOf(args[1]!)}`) },
	{ op: "seq.filter", impl: "native", because: "`#select` is Ruby's own name for filter", cost: allocating, emit: (args) => raw(`${print(args[0]!)}.select ${blockOf(args[1]!)}`) },
	{ op: "seq.any", impl: "native", cost: linear, emit: (args) => raw(`${print(args[0]!)}.any? ${blockOf(args[1]!)}`) },
	{ op: "seq.all", impl: "native", cost: linear, emit: (args) => raw(`${print(args[0]!)}.all? ${blockOf(args[1]!)}`) },
	{ op: "seq.find", impl: "native", cost: linear, emit: (args) => raw(`${print(args[0]!)}.find ${blockOf(args[1]!)}`) },
	{ op: "seq.sum", impl: "native", cost: linear, emit: (args) => raw(`${print(args[0]!)}.sum`) },
	{ op: "seq.indexOf", impl: "native", cost: linear, emit: (args) => raw(`(${print(args[0]!)}.index(${print(args[1]!)}) || -1)`) },
	{ op: "seq.contains", impl: "native", cost: linear, emit: (args) => raw(`${print(args[0]!)}.include?(${print(args[1]!)})`) },
	{ op: "seq.concat", impl: "native", cost: allocating, emit: binary("+") },
	{
		op: "seq.slice",
		impl: "library",
		because: "Array#[] has the same past-the-end-answers-nil gap String#[] has, so the total form needs the same explicit clamp",
		cost: allocating,
		deps: ["_support"],
		emit: (args, _types, ctx) => {
			ctx.require("_support");
			return raw(`seq_slice(${print(args[0]!)}, ${print(args[1]!)}, ${print(args[2]!)})`);
		},
	},
	{ op: "seq.reverse", impl: "native", cost: allocating, emit: (args) => raw(`${print(args[0]!)}.reverse`) },
	{
		op: "seq.sortStable",
		impl: "library",
		because: "Array#sort is not specified stable, so a decorate/sort/undecorate helper breaks ties by original position",
		cost: { alloc: "one", time: "nlogn" },
		deps: ["_support"],
		emit: (args, _types, ctx) => {
			ctx.require("_support");
			return raw(`stable_sort_by_comparator(${print(args[0]!)}, ${print(args[1]!)})`);
		},
	},
	{
		op: "seq.sortStableBy",
		impl: "library",
		because: "Array#sort_by is not specified stable either, so the same decorate/sort/undecorate helper is used with a key",
		cost: { alloc: "one", time: "nlogn" },
		deps: ["_support"],
		emit: (args, _types, ctx) => {
			ctx.require("_support");
			return raw(`stable_sort_by_key(${print(args[0]!)}, ${print(args[1]!)})`);
		},
	},

	{ op: "dec.fromScaled", impl: "native", cost: cheap, emit: (args) => args[0]! },
	{ op: "dec.fromInt", impl: "native", cost: cheap, emit: (args, types) => raw(`${print(args[0]!)} * ${10 ** scaleOf(types[1])}`) },
	{ op: "dec.add", impl: "native", cost: cheap, emit: binary("+") },
	{ op: "dec.sub", impl: "native", cost: cheap, emit: binary("-") },
	{ op: "dec.mul", impl: "native", cost: cheap, emit: binary("*") },
	{ op: "dec.compare", impl: "native", cost: cheap, emit: (args) => raw(`(${print(args[0]!)} <=> ${print(args[1]!)})`) },
	{ op: "dec.isNegative", impl: "native", cost: cheap, emit: (args) => raw(`${print(args[0]!)}.negative?`) },
	{ op: "dec.abs", impl: "native", cost: cheap, emit: (args) => raw(`${print(args[0]!)}.abs`) },
	{ op: "dec.unscaled", impl: "native", cost: cheap, emit: (args) => args[0]! },

	{
		op: "date.clampEpochDays",
		impl: "native",
		cost: cheap,
		emit: (args) => raw(`${print(args[0]!)}.clamp(-719162, 2932896)`),
	},
	{ op: "date.toEpochDays", impl: "native", cost: cheap, emit: (args) => args[0]! },
	{
		op: "date.fromEpochDays",
		impl: "native",
		cost: cheap,
		emit: (args) => checked(print(args[0]!), `${print(args[0]!)} >= -719162 && ${print(args[0]!)} <= 2932896`),
	},
	{
		op: "date.fromYmd",
		impl: "portable",
		cost: linear,
		sourceFn: "std/date::ymdToDays",
		emit: (args, _types, ctx) => raw(`${ctx.nameOf("std/date::ymdToDays")}(${args.map(print).join(", ")})`),
	},
	{ op: "date.year", impl: "portable", cost: cheap, sourceFn: "std/date::yearFromDays", emit: (args, _types, ctx) => raw(`${ctx.nameOf("std/date::yearFromDays")}(${print(args[0]!)})`) },
	{ op: "date.month", impl: "portable", cost: cheap, sourceFn: "std/date::monthFromDays", emit: (args, _types, ctx) => raw(`${ctx.nameOf("std/date::monthFromDays")}(${print(args[0]!)})`) },
	{ op: "date.day", impl: "portable", cost: cheap, sourceFn: "std/date::dayFromDays", emit: (args, _types, ctx) => raw(`${ctx.nameOf("std/date::dayFromDays")}(${print(args[0]!)})`) },
	{
		op: "date.addDays",
		impl: "native",
		cost: cheap,
		emit: (args) =>
			checked(
				`${print(args[0]!)} + ${print(args[1]!)}`,
				`${print(args[0]!)} + ${print(args[1]!)} >= -719162 && ${print(args[0]!)} + ${print(args[1]!)} <= 2932896`,
			),
	},
	{ op: "date.diffDays", impl: "native", cost: cheap, emit: binary("-") },
	{ op: "date.compare", impl: "native", cost: cheap, emit: (args) => raw(`(${print(args[0]!)} <=> ${print(args[1]!)})`) },
	{ op: "date.dayOfWeek", impl: "native", cost: cheap, emit: (args) => raw(`((${print(args[0]!)} + 3) % 7) + 1`) },
	{ op: "date.isLeapYear", impl: "native", cost: cheap, emit: (args) => raw(`((${print(args[0]!)} % 4 == 0 && ${print(args[0]!)} % 100 != 0) || ${print(args[0]!)} % 400 == 0)`) },

	{
		op: "re.retain",
		impl: "native",
		because: "gsub with the negated class is one pass",
		cost: allocating,
		emit: (args, _types, ctx) => {
			const pattern = ctx.regex === undefined ? "" : printRegex(ctx.regex.node, "ruby");
			return raw(`${print(args[0]!)}.gsub(Regexp.new(${rubyString(`[^${classBody(pattern)}]`)}), "")`);
		},
	},
	{
		op: "re.test",
		impl: "native",
		because: "`\\A\\z` anchors the whole string, and the normalized pattern uses explicit classes",
		cost: linear,
		emit: (args, _types, ctx) => {
			const pattern = ctx.regex === undefined ? "" : printRegex(ctx.regex.node, "ruby");
			return raw(`Regexp.new(${rubyString(`\\A${pattern}\\z`)}).match?(${print(args[0]!)})`);
		},
	},

	{
		op: "http.request",
		impl: "native",
		cost: { alloc: "many", time: "linear" },
		emit: (args, _types, ctx) => raw(`${print(ctx.env())}.request(${print(args[0]!)})`),
	},
	{ op: "clock.now", impl: "native", cost: cheap, emit: (_args, _types, ctx) => raw(`${print(ctx.env())}.now`) },
	{ op: "clock.sleep", impl: "native", cost: cheap, emit: (args, _types, ctx) => raw(`${print(ctx.env())}.sleep(${print(args[0]!)})`) },
	{ op: "clock.millis", impl: "native", cost: cheap, emit: (args) => args[0]! },
	{ op: "clock.durationMillis", impl: "native", cost: cheap, emit: (args) => args[0]! },
	{ op: "clock.elapsed", impl: "native", cost: cheap, emit: (args) => raw(`[0, ${print(args[1]!)} - ${print(args[0]!)}].max`) },
	{ op: "random.nextU32", impl: "native", cost: cheap, emit: (_args, _types, ctx) => raw(`${print(ctx.env())}.next_u32`) },
	{
		op: "task.race",
		impl: "library",
		because: "a Thread per task with a Queue collecting the first present answer is the standard library's way to run idempotent requests concurrently",
		cost: { alloc: "many", time: "linear" },
		deps: ["_support"],
		emit: (args, _types, ctx) => {
			ctx.require("_support");
			return raw(`race_first_some(${print(args[0]!)})`);
		},
	},
];

function scaleOf(type: SemType | undefined): number {
	return type !== undefined && type.kind === "Int" ? Number(type.lo) : 0;
}

/** The body of a printed class, so a lowering can negate it (`re.retain`). */
function classBody(printed: string): string {
	return printed.startsWith("[") && printed.endsWith("]") ? printed.slice(1, -1) : printed;
}

/** The 25 JavaScript-trim code points, as a Ruby regex character class body. */
function trimClassBody(): string {
	return TRIM_CODE_POINTS.map((point) => `\\u{${point.toString(16)}}`).join("");
}

export const RUBY_SPEC: TargetSpec = {
	name: "ruby",
	table: new LoweringTable(RUBY_CANDIDATES),
	naming: {
		func: (name) => snake(name),
		value: (name) => snake(name),
		field: (name) => snake(name),
		type: (name) => name,
		module: (path) => `${path.split("/").map(snake).join("/")}.rb`,
	},
	// A fold has no single idiomatic Ruby spelling as clean as `#map`/`#select`'s block form (Core
	// only ever binds two positional names, where `#reduce`'s single-arg block form pairs the
	// accumulator with the element inside a destructured pair), so it is turned into a loop, the
	// same choice Python makes for the same reason.
	loopCombinators: new Set(["seq.fold"]),
	statementTernary: false,
	errorsAsValues: false,
	asyncColouring: false,
	envType: { kind: "Record", name: "Capabilities" },
};

function snake(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replaceAll("-", "_")
		.toLowerCase();
}

/* ------------------------------------------------------------------ *
 * Printer
 * ------------------------------------------------------------------ */

/**
 * Unique names for a flattened nested ternary's own inner value — see `flattenTernaryBranch`.
 * Global rather than per-function: Ruby methods each have their own local scope, so reusing a
 * name across two different methods is harmless, and a single ever-increasing counter is simpler
 * than threading function boundaries through this printer.
 */
let ternaryTempCounter = 0;

/**
 * `a ? b : (c ? d : e)` is a nested ternary, which standardrb's `Style/NestedTernaryOperator`
 * always wants rewritten — and whose own autocorrection, run against this printer's output,
 * hit a genuine RuboCop bug (`Layout/EndAlignment` looping between two "fixed" indentations
 * without ever converging, crashing `standardrb --fix` outright, on `lib/format.rb`'s
 * `group_thousands`). Generating the flattened form directly avoids relying on an autocorrection
 * this printer cannot see fail: the inner ternary is bound to its own local first, so the outer
 * one's branches are ordinary names, never another ternary node.
 *
 * Binding it *before* the outer test runs — rather than only inside the branch that needs it —
 * changes evaluation order (eager instead of lazy), which is sound only because every expression
 * in this subset is pure (`docs/semantics.md` §7: no side effects, no observable exceptions
 * outside `Fail`, which never appears inside a combinator's lambda or a checked accessor); a
 * `checked(...)` ternary's own test is exactly what makes its "present" branch safe to evaluate
 * unconditionally, so evaluating it a statement early changes nothing observable.
 */
function flattenTernaryBranch(branch: TExpr, bindings: string[]): string {
	if (branch.kind !== "ternary") return print(branch);
	ternaryTempCounter += 1;
	const name = `nested_${ternaryTempCounter}`;
	bindings.push(`${name} = ${print(branch)}`);
	return name;
}

export function print(expr: TExpr): string {
	switch (expr.kind) {
		case "lit":
			return literal(expr.value);
		case "name":
			return expr.name;
		case "raw":
			return expr.text;
		case "call":
			return `${print(expr.callee)}(${expr.args.map(print).join(", ")})`;
		case "method":
			return `${print(expr.target)}.${expr.name}(${expr.args.map(print).join(", ")})`;
		case "member":
			return `${print(expr.target)}.${expr.name}`;
		case "index":
			return `${print(expr.target)}[${print(expr.index)}]`;
		case "binary":
			return `(${print(expr.left)} ${expr.op} ${print(expr.right)})`;
		case "unary": {
			if (expr.op === "!" && expr.operand.kind === "binary" && expr.operand.op === "==") {
				return `(${print(expr.operand.left)} != ${print(expr.operand.right)})`;
			}
			return expr.op === "!" ? `!(${print(expr.operand)})` : `${expr.op}${print(expr.operand)}`;
		}
		case "ternary": {
			const bindings: string[] = [];
			const then_ = flattenTernaryBranch(expr.then, bindings);
			const else_ = flattenTernaryBranch(expr.otherwise, bindings);
			const core = `${print(expr.test)} ? ${then_} : ${else_}`;
			return bindings.length === 0 ? `(${core})` : `(${bindings.join("; ")}; ${core})`;
		}
		case "list":
			return `[${expr.items.map(print).join(", ")}]`;
		case "record":
			return `${expr.typeName}.new(${expr.fields.map((field) => `${field.name}: ${print(field.value)}`).join(", ")})`;
		case "lambda": {
			const params = expr.params.map((param) => param.name).join(", ");
			if (expr.body.length === 1 && expr.body[0]!.kind === "return" && expr.body[0]!.value !== undefined) {
				return `->(${params}) { ${print(expr.body[0]!.value!)} }`;
			}
			return `->(${params}) {\n${printBody(expr.body, 1)}\n}`;
		}
		case "none":
		case "zero":
			return "nil";
		case "some":
			return print(expr.inner);
		default: {
			const exhaustive: never = expr;
			return exhaustive;
		}
	}
}

function literal(value: Value): string {
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "string") return rubyString(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
	return "nil";
}

/**
 * Escapes a Ruby double-quoted string literal. Not `tast.ts`'s shared `asciiString`: that helper
 * spells an astral scalar `\Uxxxxxxxx`, valid in JavaScript and Python source but not in Ruby,
 * which only ever reads a variable-length `\u{...}`; and a Ruby double-quoted string additionally
 * treats a bare `#` as the start of interpolation (`#{...}`, `#@ivar`, `#$global`), which none of
 * JavaScript, Python or Go's literal syntax does, so `#` needs its own escape here too.
 */
function rubyString(value: string): string {
	let out = '"';
	for (const scalar of value) {
		const point = scalar.codePointAt(0)!;
		if (scalar === '"') out += '\\"';
		else if (scalar === "\\") out += "\\\\";
		else if (scalar === "#") out += "\\#";
		else if (point === 0x0a) out += "\\n";
		else if (point === 0x0d) out += "\\r";
		else if (point === 0x09) out += "\\t";
		else if (point < 0x20 || point > 0x7e) out += `\\u{${point.toString(16)}}`;
		else out += scalar;
	}
	return `${out}"`;
}

function printBody(body: readonly TStmt[], depth: number): string {
	if (body.length === 0) return "";
	return body.map((statement) => printStmt(statement, depth)).join("\n");
}

function printStmt(statement: TStmt, depth: number): string {
	const pad = "  ".repeat(depth);
	switch (statement.kind) {
		case "let":
			return `${pad}${statement.name} = ${print(statement.init)}`;
		case "multiLet":
			return `${pad}${statement.names.join(", ")} = ${print(statement.init)}`;
		case "assign":
			return `${pad}${print(statement.target)} = ${print(statement.value)}`;
		case "if": {
			const head = `${pad}if ${print(statement.test)}\n${printBody(statement.then, depth + 1)}`;
			const tail = statement.otherwise.length === 0 ? "" : `\n${pad}else\n${printBody(statement.otherwise, depth + 1)}`;
			return `${head}${tail}\n${pad}end`;
		}
		case "switch": {
			const branches = statement.cases.map(
				(entry) => `${pad}when ${entry.values.map((value) => literal(value)).join(", ")}\n${printBody(entry.body, depth + 1)}`,
			);
			const fallback = statement.otherwise === undefined ? "" : `\n${pad}else\n${printBody(statement.otherwise, depth + 1)}`;
			return `${pad}case ${print(statement.subject)}\n${branches.join("\n")}${fallback}\n${pad}end`;
		}
		case "for": {
			const step = statement.step;
			const to = print(statement.to);
			const bound = statement.inclusive ? to : step > 0n ? `${to} - 1` : `${to} + 1`;
			return `${pad}(${print(statement.from)}).step(${bound}, ${step}) { |${statement.name}|\n${printBody(statement.body, depth + 1)}\n${pad}}`;
		}
		case "forEach":
			return `${pad}${print(statement.iterable)}.each { |${statement.name}|\n${printBody(statement.body, depth + 1)}\n${pad}}`;
		case "return":
			return statement.value === undefined ? `${pad}return` : `${pad}return ${print(statement.value)}`;
		case "throw":
			return `${pad}raise ${statement.errorClass}.new(${statement.args.map(print).join(", ")})`;
		case "break":
			return `${pad}break`;
		case "continue":
			return `${pad}next`;
		case "expr":
			return `${pad}${print(statement.expr)}`;
		case "raw":
			return `${pad}${statement.text}`;
		default: {
			const exhaustive: never = statement;
			return exhaustive;
		}
	}
}

function docComment(text: string, indent: string): string {
	return text
		.split("\n")
		.map((line) => (line === "" ? `${indent}#` : `${indent}# ${line}`))
		.join("\n");
}

export function printFunction(fn: TFunc): string {
	const params = fn.params.map((param) => param.name).join(", ");
	const doc = fn.doc === undefined ? "" : `${docComment(fn.doc, "  ")}\n`;
	const body = printBody(fn.body, 2);
	return `${doc}  def self.${fn.name}(${params})\n${body === "" ? "" : `${body}\n`}  end`;
}

export function printRecord(record: TRecord): string {
	const fields = record.fields.map((field) => `:${field.name}`).join(", ");
	const doc = record.doc === undefined ? "" : `${docComment(record.doc, "  ")}\n`;
	return `${doc}  ${record.name} = Data.define(${fields})`;
}

/** A module path as a Ruby constant-name fragment: `lib/cnpj` becomes `LIB_CNPJ`. */
function identifierPrefix(sourcePath: string): string {
	return sourcePath.split(/[^a-zA-Z0-9]+/u).filter((part) => part !== "").join("_").toUpperCase();
}

/**
 * Compiles every pattern once, at load time, instead of on every call.
 *
 * `Regexp.new(literal)` builds a fresh pattern object on every call it appears in; hoisting it to
 * a module-level constant is both the performance fix (the same reasoning Python's and Go's
 * backends apply to their own pattern compilation) and what a Ruby author would write. The names
 * carry the module so a reader can tell where a pattern came from.
 */
function hoistPatterns(module: TModule, body: string): { body: string; declarations: string[] } {
	const names = new Map<string, string>();
	const prefix = identifierPrefix(module.sourcePath);
	const hoisted = body.replaceAll(/\bRegexp\.new\((("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*'))\)/gu, (_match, literal: string) => {
		const existing = names.get(literal);
		if (existing !== undefined) return existing;
		const name = `${prefix}_PATTERN_${names.size + 1}`;
		names.set(literal, name);
		return name;
	});
	const declarations = [...names].map(([literalText, name]) => `  ${name} = Regexp.new(${literalText})`);
	return { body: hoisted, declarations };
}

/**
 * Marks every function its source module never exported as a private singleton method: bare calls
 * from a sibling method inside the same reopened `module Core` still resolve it (Ruby's implicit
 * receiver is `self` there, and `private_class_method` only blocks an *explicit* receiver), but a
 * caller outside this module cannot spell `Core.helper(...)` any more than Python's leading
 * underscore lets one write `module.helper(...)`. No renaming is needed the way Python's `_`
 * prefix needs it: `def self.foo` and `private_class_method :foo` both name the same, unqualified
 * `foo`.
 */
function privateNames(module: TModule): string[] {
	return module.functions.filter((fn) => !fn.moduleExported).map((fn) => fn.name);
}

export function printModule(module: TModule): string {
	const functions = module.functions.map(printFunction).join("\n\n");
	const patterns = hoistPatterns(module, functions);
	const records = module.records.map(printRecord).join("\n\n");
	// Module level constants are upper cased, the way Ruby actually *requires* a constant to be
	// spelled (a lower-case module-body assignment is a local variable, invisible from inside a
	// `def self.` method defined later in the very same block), so every reference to one is upper
	// cased too. Driven by the module's own constants rather than a pattern guessing at their
	// names, which would silently miss one shaped differently.
	const constantNames = new Map(module.constants.map((constant) => [constant.name, constant.name.toUpperCase()]));
	const upper = (text: string): string =>
		[...constantNames].reduce((body, [name, upperName]) => body.replaceAll(new RegExp(`\\b${name}\\b`, "gu"), upperName), text);
	const constants = module.constants
		.map((constant) => `  ${constantNames.get(constant.name)} = ${print(constant.value)}`)
		.join("\n");

	const requirePaths = new Set<string>();
	for (const item of module.imports) {
		requirePaths.add(item.from === "SUPPORT" ? importPath(module.sourcePath, "_support") : item.from);
	}
	if (module.requires.includes("_support")) requirePaths.add(importPath(module.sourcePath, "_support"));

	const parts: string[] = [module.header, "", "# frozen_string_literal: true", ""];
	for (const target of [...requirePaths].sort()) parts.push(`require_relative "${target}"`);
	if (requirePaths.size > 0) parts.push("");

	parts.push(`module ${RUBY_CONFIG.moduleName}`);
	const body: string[] = [];
	if (records !== "") body.push(records);
	if (constants !== "") body.push(constants);
	for (const declaration of patterns.declarations) body.push(declaration);
	if (patterns.body !== "") body.push(upper(patterns.body));
	const privates = privateNames(module);
	if (privates.length > 0) {
		body.push(`  private_class_method ${privates.map((name) => `:${name}`).join(", ")}`);
	}
	parts.push(body.join("\n\n"));
	parts.push("end");
	return `${parts.join("\n").trimEnd()}\n`;
}

function importPath(from: string, to: string): string {
	const rel = relativePath(dirname(from) === "." ? "" : dirname(from), to).split("\\").join("/");
	return rel.split("/").map(snake).join("/");
}

function supportModule(_program: CProgram, needs: SupportNeeds): { path: string; text: string } {
	const parts = [
		"# Code generated by the logic engine. DO NOT EDIT.",
		`# engine: ${ENGINE_VERSION}`,
		"# source: _support",
		"",
		"# frozen_string_literal: true",
		"",
	];
	if (needs.env) {
		parts.push("require \"net/http\"", "require \"uri\"", "");
	}
	parts.push(`module ${RUBY_CONFIG.moduleName}`, "");

	if (needs.env) {
		parts.push(
			"  HttpHeader = Data.define(:name, :value)",
			"",
			"  HttpRequest = Data.define(:method, :url, :headers, :body, :timeout_millis)",
			"",
			"  HttpResponse = Data.define(:status, :headers, :body)",
			"",
		);
	}

	parts.push(
		"  # `from` and `to` are proven non-negative by the checker (`str.slice`'s signature); only",
		"  # `to` can still exceed the string's length, since `String#[]` answers nil rather than an",
		"  # empty string when the *start* of a range is past the end.",
		"  def self.str_slice(value, from, to)",
		"    length = value.length",
		"    lo = from > length ? length : from",
		"    hi = to > length ? length : to",
		"    hi = lo if hi < lo",
		"    value[lo...hi]",
		"  end",
		"",
		"  # Same gap as `str_slice`, for Array#[].",
		"  def self.seq_slice(list, from, to)",
		"    length = list.length",
		"    lo = from > length ? length : from",
		"    hi = to > length ? length : to",
		"    hi = lo if hi < lo",
		"    list[lo...hi]",
		"  end",
		"",
		"  # `String#split` drops trailing empty fields by default, and answers `[]` rather than",
		"  # `[\"\"]` for an empty receiver; passing a negative limit fixes the first, and the empty",
		"  # receiver is special cased to fix the second -- matching JavaScript's and Python's",
		"  # `split`, which the Core's own reference semantics is defined against.",
		"  def self.str_split(value, separator)",
		"    value.empty? ? [\"\"] : value.split(separator, -1)",
		"  end",
		"",
		"  # Truncated division/remainder: Ruby's own `/` and `%` floor, so a divisor and dividend of",
		"  # differing sign need the sign corrected back to the dividend's.",
		"  def self.trunc_div(left, right)",
		"    quotient = left.abs / right.abs",
		"    (left.negative? != right.negative?) ? -quotient : quotient",
		"  end",
		"",
		"  def self.trunc_mod(left, right)",
		"    remainder = left.abs % right.abs",
		"    left.negative? ? -remainder : remainder",
		"  end",
		"",
		"  # Decorate/sort/undecorate: Array#sort and Array#sort_by are not specified stable, so the",
		"  # original index breaks a tie the comparator or key called equal.",
		"  def self.stable_sort_by_comparator(list, comparator)",
		"    list.each_with_index",
		"      .sort { |(a, ia), (b, ib)| result = comparator.call(a, b); result.zero? ? (ia <=> ib) : result }",
		"      .map(&:first)",
		"  end",
		"",
		"  def self.stable_sort_by_key(list, key)",
		"    list.each_with_index.sort_by { |el, i| [key.call(el), i] }.map(&:first)",
		"  end",
		"",
	);

	if (needs.race) {
		parts.push(
			"  # Runs every task on its own Thread and takes the first one that answers present.",
			"  # Cancellation is best effort and semantically unobservable (`docs/semantics.md` \u00a74.2):",
			"  # a losing thread may run to completion, and its answer is simply dropped.",
			"  def self.race_first_some(tasks)",
			"    queue = Queue.new",
			"    threads = tasks.map do |task|",
			"      Thread.new do",
			"        begin",
			"          queue.push(task.call)",
			"        rescue StandardError",
			"          queue.push(nil)",
			"        end",
			"      end",
			"    end",
			"    begin",
			"      tasks.length.times do",
			"        answer = queue.pop",
			"        return answer unless answer.nil?",
			"      end",
			"      nil",
			"    ensure",
			"      threads.each { |thread| thread.kill }",
			"    end",
			"  end",
			"",
		);
	}

	if (needs.env) {
		parts.push(
			"  # The default environment, built from the standard library only. Not part of the",
			"  # generated core's public API on its own -- a utility that reaches Http, Clock or",
			"  # Random keeps its own source signature and calls a `_with` seam that defaults to",
			"  # `DEFAULT_CAPABILITIES`, built once here rather than once per call",
			"  # (`docs/decisions/0011-public-entry-points-vs-capabilities.md`).",
			"  class Capabilities",
			"    def request(request)",
			"      uri = URI.parse(request.url)",
			"      http = Net::HTTP.new(uri.host, uri.port)",
			"      http.use_ssl = uri.scheme == \"https\"",
			"      http.open_timeout = request.timeout_millis / 1000.0",
			"      http.read_timeout = request.timeout_millis / 1000.0",
			"      body = request.body == \"\" ? nil : request.body",
			"      req = Net::HTTP::Get.new(uri)",
			"      case request.method",
			"      when \"POST\" then req = Net::HTTP::Post.new(uri)",
			"      when \"PUT\" then req = Net::HTTP::Put.new(uri)",
			"      when \"DELETE\" then req = Net::HTTP::Delete.new(uri)",
			"      when \"PATCH\" then req = Net::HTTP::Patch.new(uri)",
			"      end",
			"      request.headers.each { |header| req[header.name] = header.value }",
			"      req.body = body unless body.nil?",
			"      response = http.request(req)",
			"      HttpResponse.new(status: response.code.to_i, headers: [], body: response.body || \"\")",
			"    rescue StandardError",
			"      nil",
			"    end",
			"",
			"    def now",
			"      (Time.now.to_r * 1000).to_i",
			"    end",
			"",
			"    def sleep(milliseconds)",
			"      Kernel.sleep(milliseconds / 1000.0)",
			"    end",
			"",
			"    def next_u32",
			"      # Not cryptographically secure, deliberately: the utilities that draw are",
			"      # generating example documents, and that is what the published package",
			"      # documents doing. A caller who needs unpredictability passes its own",
			"      # capability, the way the conformance harness passes a seeded one.",
			"      Random.rand(0...4_294_967_296)",
			"    end",
			"  end",
			"",
			"  # The platform default, built once at load time rather than per call -- every public",
			"  # wrapper (docs/decisions/0011-public-entry-points-vs-capabilities.md) shares this one",
			"  # instance, the same way a caller who builds their own environment would share it.",
			"  DEFAULT_CAPABILITIES = Capabilities.new",
			"",
		);
	}

	parts.push("end");
	return { path: "_support.rb", text: `${parts.join("\n").trimEnd()}\n` };
}

function errorsModule(program: CProgram): { path: string; text: string } | undefined {
	const declared = [...program.errors.values()];
	if (declared.length === 0) return undefined;
	const lines = [
		"# Code generated by the logic engine. DO NOT EDIT.",
		`# engine: ${ENGINE_VERSION}`,
		"# source: errors",
		"",
		"# frozen_string_literal: true",
		"",
		`module ${RUBY_CONFIG.moduleName}`,
		"  # The root of every domain error the core raises.",
		"  class DomainError < StandardError",
		"  end",
		"",
	];
	for (const error of declared) {
		lines.push(
			`  # ${(error.doc ?? error.name).split("\n")[0]}`,
			`  class ${error.name} < ${error.base ?? "DomainError"}`,
			"  end",
			"",
		);
	}
	lines.push("end");
	return { path: "errors.rb", text: `${lines.join("\n").trimEnd()}\n` };
}

/** The generated differential driver: one JSON line in, one JSON line out. */
function driverFiles(_program: CProgram, entries: readonly DriverEntry[]): { path: string; text: string }[] {
	const modulePaths = new Set<string>();
	for (const entry of entries) modulePaths.add(entry.modulePath);
	const needsEnv = entries.some((entry) => entry.usesEnv);

	const lines = [
		"# Code generated by the logic engine. DO NOT EDIT.",
		"# source: _driver",
		"",
		"# frozen_string_literal: true",
		"",
		"require \"json\"",
		...[...modulePaths].sort().map((path) => `require_relative "${path.replace(/\.rb$/, "")}"`),
		...(needsEnv ? ["require_relative \"_support\""] : []),
		"",
		"# A generated record is a Data value object, which JSON does not know how to serialize.",
		"def encode(value)",
		"  if value.is_a?(Array)",
		"    value.map { |item| encode(item) }",
		"  elsif value.is_a?(Data)",
		"    value.to_h.transform_values { |item| encode(item) }",
		"  else",
		"    value",
		"  end",
		"end",
		"",
	];

	if (needsEnv) {
		lines.push(
			"# The reference PCG32: same constants and default seed as the interpreter's, so a draw",
			"# matches the reference bit for bit. A fresh instance is built for every request, the same",
			"# way the reference model starts a fresh interpreter, and so a fresh generator, per case.",
			"class Pcg32",
			"  MASK64 = (1 << 64) - 1",
			"  MASK32 = (1 << 32) - 1",
			"  INCREMENT = 1442695040888963407",
			"",
			"  def initialize(seed)",
			"    @state = 0",
			"    next_u32",
			"    @state = (@state + seed) & MASK64",
			"    next_u32",
			"  end",
			"",
			"  def next_u32",
			"    previous = @state",
			"    @state = (previous * 6364136223846793005 + INCREMENT) & MASK64",
			"    xorshifted = (((previous >> 18) ^ previous) >> 27) & MASK32",
			"    rotation = previous >> 59",
			"    ((xorshifted >> rotation) | (xorshifted << ((-rotation) & 31))) & MASK32",
			"  end",
			"end",
			"",
			"# The interpreter's own default: its constructor falls back to this seed whenever",
			"# `Capabilities.seed` is left unset, which is how every conformance case runs it.",
			"DEFAULT_SEED = 0x853C49E6748FEA9B",
			"",
			"# The capability fake the differential harness drives: responses come from fixtures.json.",
			"class FakeCapabilities",
			"  def initialize(fixtures)",
			"    @fixtures = fixtures",
			"    @random = Pcg32.new(DEFAULT_SEED)",
			"  end",
			"",
			"  def request(request)",
			"    fixture = @fixtures[request.url]",
			"    return nil if fixture.nil?",
			"",
			"    Kernel.sleep((fixture[\"latencyMillis\"] || 0) / 1000.0)",
			"    Core::HttpResponse.new(status: fixture[\"status\"], headers: [], body: fixture[\"body\"])",
			"  end",
			"",
			"  def now",
			"    0",
			"  end",
			"",
			"  def sleep(milliseconds)",
			"    Kernel.sleep(milliseconds / 1000.0)",
			"  end",
			"",
			"  def next_u32",
			"    @random.next_u32",
			"  end",
			"end",
			"",
			"FIXTURE_PATH = File.join(__dir__, \"fixtures.json\")",
			"FIXTURES = File.exist?(FIXTURE_PATH) ? JSON.parse(File.read(FIXTURE_PATH)) : nil",
			"",
		);
	}

	const dispatch = entries.map((entry) => {
		const args = entry.params.map((param, index) => {
			if (param.kind !== "Record") return `args[${index}]`;
			const definition = _program.records.get(param.name);
			const fields = (definition?.fields ?? [])
				.map((field) => `${snake(field.name)}: args[${index}][${JSON.stringify(field.name)}]`)
				.join(", ");
			return `Core::${param.name}.new(${fields})`;
		});
		if (entry.usesEnv) args.push("environment");
		const envParam = entry.usesEnv ? "environment" : "_environment";
		return `    ${JSON.stringify(entry.coreName)} => ->(args, ${envParam}) { Core.${entry.targetName}(${args.join(", ")}) },`;
	});

	lines.push(
		"HANDLERS = {",
		...dispatch,
		"}.freeze",
		"",
		"# The sandboxed environment's default external encoding is not always UTF-8; the protocol",
		"# always is.",
		"$stdin.set_encoding(Encoding::UTF_8)",
		"$stdout.set_encoding(Encoding::UTF_8)",
		"",
		"$stdin.each_line do |line|",
		"  line = line.strip",
		"  next if line.empty?",
		"",
		"  request = JSON.parse(line)",
		...(needsEnv
			? [
					"  # A fresh environment per line: next_u32 starts from the same state the reference",
					"  # model's fresh interpreter starts from for every case.",
					"  environment = FIXTURES.nil? ? Core::DEFAULT_CAPABILITIES : FakeCapabilities.new(FIXTURES)",
				]
			: ["  environment = nil"]),
		"",
		"  begin",
		"    value = HANDLERS[request[\"fn\"]].call(request[\"args\"], environment)",
		"    puts JSON.generate({ \"ok\" => true, \"value\" => encode(value) })",
		"  rescue Core::DomainError => e",
		"    puts JSON.generate({ \"ok\" => false, \"error\" => e.class.name.sub(\"Core::\", \"\") })",
		"  end",
		"  $stdout.flush",
		"end",
		"",
	);

	return [{ path: "_driver.rb", text: `${lines.join("\n").trimEnd()}\n` }];
}

export const RUBY_BACKEND: Backend = {
	spec: RUBY_SPEC,
	fileExtension: RUBY_CONFIG.fileExtension,
	printModule,
	importPath,
	support: supportModule,
	errorsModule,
	renderType: rubyType,
	comment: "#",
	driver: driverFiles,
	supportImport: (needs, usesEnv, builtins) => {
		const names = builtins.slice();
		if (usesEnv && needs.env) names.push("Capabilities");
		return [{ from: "SUPPORT", names }];
	},
	defaultCapabilities: {
		ref: { kind: "name", name: "DEFAULT_CAPABILITIES" },
		imports: [],
		seamName: (publicName) => `${publicName}_with`,
	},
};
