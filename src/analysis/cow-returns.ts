/**
 * Cow-return inference: a whole-program pre-pass, layered on top of `analysis/borrows.ts`'s
 * parameter borrowing, that decides which functions may print their Rust return type as
 * `std::borrow::Cow<'_, str>` instead of an owned `String`.
 *
 * See `engine/docs/decisions/0014-rust-derived-string-returns-may-borrow.md` for the measurement
 * that motivated this and the soundness argument in full; this module is the "when is it sound"
 * half of that decision, made mechanical.
 *
 * The condition, enforced entirely below rather than by hand: a function is Cow-eligible only
 * when its *entire* body is one `return <op>(<param>)`, where `<op>` is drawn from a small,
 * explicit set of operations that can hand back their own input unchanged (today, only
 * `re.retain` — see `COW_SOURCE_OPS`), `<param>` is a bare, untransformed reference to the
 * function's *only* parameter, and that parameter was already found borrowable by
 * `computeBorrowableParams`. Every one of these is a purely structural fact about the function's
 * own declaration, not about how any caller uses the result — the caller-side half of soundness
 * (never handing a `Cow` to a position that needs a concrete `String` without converting first)
 * is a printer concern, not an eligibility one, and lives in the Rust backend's own `toOwned`
 * instead: seeing this module's answer as "borrow when nothing has to change" rather than
 * "borrow only where every caller happens to read" is what let `keep_digits` qualify even though
 * one of its callers (`get-address-info-by-cep.ts`) stores the result into a record field — a
 * `.into_owned()` at that one call site is all a store position needs, and it is exactly as sound
 * as the `.to_owned()` `toOwned` already prints for an owned local everywhere else.
 *
 * Two structural requirements exist purely to keep the printed function honest, not because a
 * looser rule would be unsound in principle:
 *
 * - Exactly one parameter, and it is the op's only argument. A function with a second parameter
 *   would still be sound to borrow from — but Rust's own elision rule only infers a `Cow<'_, str>`
 *   return's lifetime from a *single* input lifetime; a second reference parameter would need an
 *   explicit named lifetime on the signature, which is more machinery this pass does not need for
 *   anything `core/source` actually contains, so a multi-parameter function is left owned instead
 *   of taught that machinery speculatively.
 * - The retained character ranges must all be ASCII (`hi <= 127`), exactly the condition
 *   `re.retain`'s own Rust candidate uses to choose its byte-wise fast path over the `.chars()`
 *   fallback. This check is duplicated here, deliberately, rather than imported: this module lives
 *   below the backends (see `tests/boundary.spec.ts`), so it cannot import a backend's own module,
 *   which is exactly what it would need to reuse that candidate's copy of the same one-line
 *   predicate without a circular import (the Rust backend already has to import *this* module, to
 *   get the eligibility set). Keeping the predicate duplicated is the smaller cost — see that
 *   candidate's own `emit` for the one true copy of what it actually does at print time, and keep
 *   this one in sync with it, because if this pass calls a function eligible for the `.chars()`
 *   fallback path, the candidate would print a plain `String` there while the signature this pass
 *   asked for says `Cow<'_, str>` — a compile error, not a silent bug, but one worth not shipping.
 */

import type { CFunc, CProgram } from "../core/ir.ts";
import type { BorrowMap } from "./borrows.ts";

/** Operations whose result may be exactly their own (borrowed) input, unchanged, byte for byte. */
const COW_SOURCE_OPS: ReadonlySet<string> = new Set([
	// `re.retain` keeps every byte that matches a class and drops the rest: when nothing was
	// dropped, the result is byte-identical to the input, so `Cow::Borrowed` is exactly right.
	"re.retain",
]);

/** The Core-qualified names (`CFunc.name`) of functions that may return `Cow<'_, str>` in Rust. */
export type CowReturnSet = ReadonlySet<string>;

/** Mirrors `re.retain`'s own ASCII-fast-path gate in the Rust backend — see the module comment. */
function isAsciiRetain(fn: CFunc): boolean {
	const value = fn.body[0];
	if (value === undefined || value.kind !== "return" || value.value === undefined) return false;
	const expr = value.value;
	if (expr.kind !== "op" || expr.regex === undefined) return false;
	const node = expr.regex.node;
	return node.kind === "class" && node.ranges.every((range) => range.hi <= 127);
}

/**
 * Whether `fn`'s entire body is `return <op>(<soleParam>)`, `<op>` a `COW_SOURCE_OPS` member,
 * `<soleParam>` a bare reference to `fn`'s only parameter, and that parameter already borrowable.
 */
function isCowEligible(fn: CFunc, borrows: BorrowMap): boolean {
	if (fn.ret.kind !== "String") return false;
	if (fn.params.length !== 1) return false;
	if (fn.body.length !== 1) return false;
	const statement = fn.body[0]!;
	if (statement.kind !== "return" || statement.value === undefined) return false;
	const expr = statement.value;
	if (expr.kind !== "op" || !COW_SOURCE_OPS.has(expr.op)) return false;
	if (expr.args.length !== 1) return false;
	const arg = expr.args[0]!;
	const param = fn.params[0]!;
	if (arg.kind !== "local" || arg.name !== param.name) return false;
	if (param.type.kind !== "String") return false;
	if (!(borrows.get(fn.name)?.has(param.name) ?? false)) return false;
	return isAsciiRetain(fn);
}

export function computeCowReturns(program: CProgram, borrows: BorrowMap): CowReturnSet {
	const eligible = new Set<string>();
	for (const fn of program.functions.values()) {
		if (isCowEligible(fn, borrows)) eligible.add(fn.name);
	}
	return eligible;
}
