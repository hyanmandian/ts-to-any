# 0014 — A Rust return value derived from a borrowed parameter may borrow it back, via `Cow`

**A scoped extension of [0010](0010-rust-parameters-borrow-where-sound.md), not a reversal of it.**
0010's own return-type paragraph stands: "nothing borrowed can outlive the call that produced it"
is still true for a plain `&str` return, which is why this decision reaches for `Cow<'_, str>`
instead — the one return shape that is a borrow *when nothing has to change* and an owned value
*when something does*, decided once per call, at compile time, from a fact this pass proves ahead
of it.

## Context

`isValidCpf`'s generated Rust cost 1.44x the handwritten crate (15.9 ms vs. 11.0 ms, 200 000
calls) after 0010 landed — down from 10.8x before it, but still the worst row this target has.
0010's own "What is left" section named the reason: `keep_digits` builds a fresh, owned 11-digit
`String` on every call, because a function's return type stays unconditionally owned regardless of
what its own parameter's borrow status is. For the benchmark's normalized input (an already-clean
digit string), that allocation holds a value byte-identical to its input.

**Is it actually the allocation?** Measured directly, in an isolated scratch crate built against a
hand-copied `keep_digits`, before writing any of this pass (`core/bench/rust`'s own README records
the same discipline for every earlier finding in this file):

| | 200 000 calls, clean 11-digit input |
| --- | ---: |
| `keep_digits` (old: unconditional `String`, byte-wise scan) | 6.5–6.8 ms |
| `keep_digits` (new: scan, then `Cow::Borrowed` or `Cow::Owned`) | 1.7–1.9 ms |

Yes: on the input shape the benchmark actually exercises, the allocation is roughly 70–75% of
`keep_digits`'s own isolated cost, and removing it (by not paying it at all, rather than paying it
faster) is the ceiling this pass could reach for that one function. The same isolated crate, run
against a masked input (one `keep_digits` still has to filter), shows the fix costs nothing extra
there either — 7.0–11.3 ms both before and after, the one extra `.bytes().all(...)` scan being
noise next to the allocation it either replaces or (when nothing can be skipped) precedes.

## Decision

`analysis/cow-returns.ts` is a second whole-program pre-pass, run after `analysis/borrows.ts` and
fed its result, that decides which functions may print their Rust return type as
`std::borrow::Cow<'_, str>`. A function is eligible only when every one of these structural facts
holds about its own declaration — nothing here is about how a caller uses the result:

- Its entire body is one `return <op>(<param>)`.
- `<op>` is drawn from a small, explicit set of operations whose result may be exactly their own
  input, unchanged (`COW_SOURCE_OPS`; today, only `re.retain` — see "Does it generalize?" below for
  why `str.trim`- and `str.slice`-shaped code does not join it, and why `keep_alphanumeric`, which
  also calls `re.retain`, still does not qualify).
- `<param>` is a bare, untransformed reference to the function's *only* parameter — not a second
  parameter among others, so `Cow<'_, str>`'s lifetime elides to the one input lifetime Rust's own
  elision rule already infers for a single-reference-parameter function, with no named lifetime
  needed on the signature.
- That parameter was already found borrowable by `computeBorrowableParams` (0010's own pass) — a
  Cow can only ever borrow *from* something that is itself a borrow; an owned parameter has nothing
  outliving the call to borrow from, so `Cow::Borrowed` would not compile.
- The retained character ranges are all ASCII (`hi <= 127`) — the exact condition `re.retain`'s own
  Rust candidate already uses to choose its byte-wise fast path over a `.chars()`-decoding
  fallback. This is checked identically in both places (deliberately duplicated rather than
  imported, since the analysis layer sits below the backends and cannot import one without a
  circular import — see `analysis/cow-returns.ts`'s own comment) because the two have to agree: if
  eligibility said yes but the fallback path printed a plain `String`, the function's own signature
  and its own body would disagree, and `cargo build` would refuse it. This project's own
  patterns are all ASCII-only (digits, upper and lower case letters), so the fallback is unexercised
  code either way, exactly as 0010's own equivalent gate already was for `re.retain` in general.

Only `keep_digits` (`core/source/lib/digits.ts`) meets every condition in this project today.
`keep_alphanumeric` calls the same `re.retain` op but wraps it in `.toUpperCase()`
(`str.asciiUpper`), which always allocates a fresh `String` regardless of whether anything was
retained — its return expression is not *just* the op call, so the structural check correctly
declines it, by the operation's own shape, not by checking its name.

### The caller side: why a store does not disqualify a function, the way the framing first suggested

The obvious, simpler rule — "eligible only when every caller reads the result and never stores it"
— turns out to be strictly worse than what this decision actually does, not merely more
conservative. `keep_digits` is called from six places, and one of them, `get-address-info-by-cep.ts`
(twice), stores the result directly into a record field (`cep: keepDigits(code)`), which
`docs/decisions/0009-*.md` and 0010 both keep unconditionally owned. Under the caller-reads-only
rule, that one store site would disqualify `keep_digits` from ever borrowing — including in
`isValidCpf`, the function this whole pass exists for.

The reason that rule is unnecessarily strict: a `Cow` converts to an owned `String` just as
cheaply, and just as correctly, as a `String` converts to another owned `String` — the only
difference is which method call does it. `toOwned` (the Rust backend's own conversion point for
every owning position — a record field, a list item, `Some(...)`, a call argument, an assignment,
another function's `return`) already exists to make exactly this kind of conversion uniform. It
needed exactly one new case: a call to a Cow-eligible function calls `.into_owned()`, not
`.to_owned()`, because `Cow<'a, str>` implements `Clone` (so the blanket `impl<T: Clone> ToOwned for
T` applies to it *before* `Deref` coercion ever gets a chance to reach `str`'s own `ToOwned`) —
`.to_owned()` on a `Cow` clones the `Cow` and keeps its type, which is not what an owning position
needs. `.into_owned()` is the call that actually produces a `String`. Once `toOwned` knows this one
case, *every* caller works correctly regardless of how it uses the result, which is what let this
decision drop the caller-side restriction from eligibility entirely and still call `keep_digits`'s
`get-address-info-by-cep.ts` call sites sound.

**The condition that is actually enforced, then, splits cleanly in two:**

1. **Eligibility (`analysis/cow-returns.ts`, whole-program, Core-level):** purely a structural fact
   about the function's own declaration, described above. Decided once, ahead of lowering, the same
   timing discipline 0010 established for parameter borrowing and for the same reason (a candidate's
   `emit` runs before any function scope exists to consult otherwise).
2. **Conversion (the Rust backend's `toOwned`, print-level, per call site):** a call to a
   Cow-eligible function is left bare only at the one place Rust's own type inference does not force
   a concrete type on it — a `let` with no declared type. Every other position `toOwned` reaches
   (record field, list item, `Some(...)`, call argument to an owned parameter, assignment, another
   function's `return`) forces `.into_owned()`, unconditionally, the same way `toOwned`'s existing
   "name" case has always forced `.to_owned()` on every occurrence, without last-use tracking. A
   ternary's two branches force ownership on *both* arms regardless of the position that contains
   the ternary, because an `if`/`else` needs the same type on both arms independent of what its own
   result will later be used for — this is what keeps `format-cnpj.ts`'s
   `options.version === "2" ? keepAlphanumeric(value) : keepDigits(value)` compiling (one branch
   `String`, the other would otherwise be `Cow`) without teaching the ternary anything about `Cow`
   at all.

This is the exact same shape 0010 used for parameters — a whole-program *structural* fact decided
once, handed to the shared lowerer and the printer as data — extended one layer further, to
returns, with the one genuinely new piece of machinery being the single `toOwned` case above.

### Where each piece lives

- `analysis/cow-returns.ts`, `computeCowReturns(program, borrows)` — the eligibility pass, taking
  0010's own `BorrowMap` as an input (a Cow return's parameter must already be borrowable).
- `backend/lower.ts`'s `LowerOptions.cowReturns` — the same threading pattern as `LowerOptions.borrows`.
  `Lowerer` tracks the current function's own eligibility (`currentCowReturn`, mirroring
  `currentBorrowedParams`) to set `TFunc.cowReturn` and, only for the return statement's own
  top-level expression, `EmitContext.cowReturn` (so `re.retain`'s own candidate can build the
  Cow-returning form of its own code). Every "call" node also carries `resultIsCow` (mirroring
  `borrowedArgs`), read by the printer at every call site, not only the function's own return.
- `backend/tast.ts` — `TFunc.cowReturn` and `TExpr` (`"call"`)`.resultIsCow`, both optional, both
  `undefined`/unset for every target but Rust, the same convention 0010's own `borrowed`/
  `borrowedArgs` fields use.
- `backend/select.ts` — `EmitContext.cowReturn`, consulted only by a candidate for an op in
  `COW_SOURCE_OPS` (today, only the Rust `re.retain` candidate); ignored by every other candidate
  and every other target.
- `targets/rust/index.ts` — `re.retain`'s candidate builds the scan-then-`Cow::Borrowed`-or-`Owned`
  form only when `ctx.cowReturn` is true, `printFunction` prints `Cow<'_, str>` for a function with
  `fn.cowReturn`, and `toOwned` gets the one new `"call"` case and the `allowBorrowed` parameter
  described above (only ever `true` from the `let` call site). `support.rs` re-exports
  `std::borrow::Cow` once (`std` does not put it in the prelude), so every generated module sees it
  through its own existing `use crate::*;` with no per-module import logic needed.

## Consequences

- **`isValidCpf` moved from 1.44x to roughly 1.17x–1.21x** the handwritten crate, measured over
  three consecutive `cargo run --release` runs of `core/bench/rust` (generated 10.6–10.7 ms,
  handwritten 8.9–9.1 ms, 200 000 calls each). The isolated `keep_digits` measurement above is
  where that gap actually closed: on the benchmark's normalized (already-clean) input, `is_valid_cpf`
  now calls `keep_digits`, `is_repeated` and two `cpf_check_digit` calls without a single heap
  allocation between them — `re.retain`'s own scan is the only pass the value takes.
- **`isValidCnpj`, `formatCnpj`, `formatCurrency`, `generateCpf`, `generateCnpj` and
  `getAddressInfoByCep` are unaffected in every sense that matters**: `git diff --stat` on
  `core/out/rust` after regenerating touches exactly four files (`lib_digits.rs`, `support.rs`,
  `format_cnpj.rs`, `get_address_info_by_cep.rs`); `is_valid_cpf.rs`, `is_valid_cnpj.rs` and
  `format_currency.rs` are byte-identical to before this decision, because every use of
  `keep_digits`/`keep_alphanumeric` those three files make already goes through a borrowed-argument
  position (`&`, resolved by `Deref` coercion with no printer change needed) rather than an owning
  one. `format_cnpj.rs` gained one `.into_owned()` (the ternary case above) and
  `get_address_info_by_cep.rs` gained two (the record-field case above); both compile, both pass
  conformance, and neither allocates any more than it already did before this decision — the
  allocation these two sites already paid is unchanged, just moved from inside `keep_digits` to the
  explicit `.into_owned()` call site.
- **TypeScript, Python and Go are untouched**: `git diff --stat core/out/typescript core/out/python
  core/out/go` after regenerating is empty. `LowerOptions.cowReturns`, `TFunc.cowReturn`,
  `TExpr.call.resultIsCow` and `EmitContext.cowReturn` are optional and Rust-only by construction,
  the same way 0010's own fields are.
- **`node engine/scripts/verify.ts core` is 17/17**, including `cargo clippy -- -D warnings`,
  `cargo fmt --check`, and the 4256-case differential conformance run in both idiom modes on all
  four targets. `Cargo.lock` still lists exactly one package; no `unsafe` was added.
- **What did not pay, and why it stayed out of scope:**
  - The `.chars()` fallback path (a non-ASCII retained class) was deliberately left owned,
    unconditionally, rather than taught the same Cow trick — this project has no pattern that
    reaches it, so there was nothing to measure, and 0010's own gate for the same fallback already
    established that unexercised paths are not where this backend spends effort.
  - `str.trim`- and `str.slice`-shaped code was considered and declined. Neither appears as a
    standalone function whose entire body is the op call the way `keep_digits` is — every use in
    `core/source` is inlined directly into a larger expression (`cnpj.trim()` inside `isValidCnpj`,
    for instance), which is a *local*-binding question, not a *function-return* one, and would need
    a materially different mechanism (tracking which locals hold a `Cow`, not which functions
    return one) to reach. That is future work, not a gap in this decision's own condition — the
    condition here is specifically about return types, and nothing in `core/source` today has a
    second function shaped like `keep_digits` to test it against.
  - A first design made function eligibility depend on every caller reading the result, matching
    the framing this task started from. It was measurably worse (it would have excluded
    `keep_digits` outright, over one caller's use in a record field) and no simpler to implement
    than teaching `toOwned` the one `.into_owned()` case instead, so it was replaced before being
    shipped, not kept as a fallback.
