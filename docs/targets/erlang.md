# Target: Erlang

**Baseline** Erlang/OTP 25. **Dependencies** standard library only. **Formatter** none available
in this toolchain (no `rebar3`, no `erlfmt`) — the printer's own output is written to be the
committed byte shape on its own; see "Determinism, with no formatter" below.
**Linters** `erlc +warn_unused_vars +warnings_as_errors` — Erlang/OTP ships no separate linter the
way `go vet`/`clippy` are one, but the compiler itself, with warnings promoted to errors, catches
exactly the class of bug this backend's own compiler can introduce (see "What the fuzzer found").

This is the hardest target this engine has built: Erlang has no loop construct and no mutable
variable at all. Stage 1 below is the feasibility case, written before any backend code, for why
that survives translation soundly; Stage 2 is what was built once it did.

---

## Stage 1 — feasibility

### Representation

| Semantic type | Erlang |
|---|---|
| `Bool` | `boolean()` (`true`/`false`) |
| `Int[lo..hi]` | `integer()` — arbitrary precision, native |
| `Float` | not lowered (no utility in `core/source` uses it — see "What was left out") |
| `Decimal<S>` | `integer()` holding the unscaled value, exactly like Go and Rust |
| `CivilDate`, `Instant`, `Duration` | `integer()` (days / milliseconds), exactly like the other three |
| `String`, `Ascii`, `Digits` | a UTF-8 **binary** (`<<"…"/utf8>>`) |
| `List<T>[min..max]` | a plain Erlang `list()` |
| `Option<T>` | `{some, T} | none` |
| `Record` | a plain Erlang `map()`, `#{field => Value, …}` |
| `Enum` | a UTF-8 binary, exactly like `String` |
| `Union` | not admitted by the checker; no lowering needed |

#### Integers

Erlang integers are arbitrary precision natively — there is no fixed-width type to overflow and no
wraparound to reason about, at all, anywhere. This is strictly *easier* than every other target:

- A **proven** `Int[lo..hi]` needs no representation decision at all. Its bound is a compile-time
  fact the checker already established; at runtime the value is just an `integer()`, and nothing
  about Erlang's own arithmetic can make it leave that bound (`+`/`-`/`*` never overflow, `div`/`rem`
  never wrap). Go's `int` has to be *assumed* 64-bit for the same guarantee (`docs/targets/go.md`);
  Erlang does not need the assumption.
- The **platform-safe domain**, ±(2^53 − 1), is the range every *other* target's default integer
  covers exactly and Erlang's covers with room to spare in every direction. Nothing here ever has to
  clamp, check for overflow, or fall back to a widened representation the way a target with a fixed
  word size would. `date.clampEpochDays` and friends still exist in the capability table — they are
  part of the *documented semantics* of the operation (the proleptic Gregorian calendar's own
  range), not a workaround for a representation limit.
- `/` and `%` are truncated toward zero, taking the sign of the dividend (`docs/semantics.md`
  §2.1) — and so are Erlang's `div` and `rem`, exactly, with no precondition needed (confirmed
  directly: `-7 div 2` is `-3`, `-7 rem 2` is `-1`, `7 div -2` is `-3`, `7 rem -2` is `1` — the same
  four cases Go and JavaScript agree on). This is a nicer position than Python's backend is in
  (`docs/semantics.md` §2.1: Python's `//`/`%` floor, so the native lowering there is gated on both
  operands being non-negative) and exactly as good as Go's.

#### Strings: binaries, argued

**Binaries**, not lists of code points. The choice matters because it decides what every other
string operation costs and means, so here is the case for it rather than a bare assertion:

- **What "index" means.** The checker only ever admits positional indexing
  (`str.codeAt`/`charAt`/`slice`) on a value proven `Ascii` (`docs/semantics.md` §2.3), and on ASCII
  a byte offset *is* a scalar offset — one byte per scalar, no decoding required. A binary makes
  that the natural, O(1) operation it is on every other target (`binary:at/2`, `binary:part/3`); a
  list of code points would make it O(n) (`lists:nth`), for the one case the type system already
  proved could be O(1).
- **What the ASCII proofs buy.** Every one of the nine utilities' own strings — CPF/CNPJ digits and
  their masks, the JSON scanner's field names, the regex classes — is ASCII, and the checker proves
  it. A binary is the representation that lets that proof *pay off*: `byte_size/1` for `str.len`,
  `binary:at/2` for `str.codeAt`, `binary:part/3` for `str.slice`, all O(1) natively, none of them
  needing a decode pass first the way a list-of-scalars representation would need an *encode* pass
  to get back to bytes for `binary:split`, `re:run`, `file:read_file`'s own binary result, and
  everything else in the standard library that already speaks binaries.
- **Comparison is code point order.** Erlang orders binaries byte by byte, and UTF-8 preserves code
  point order byte-for-byte by construction (a documented, provable UTF-8 property) — so
  `str.compare` is native comparison, `A < B`, with no ASCII precondition at all, the same position
  Go is in for the same reason (`strings.Compare` on UTF-8 bytes) and a *better* one than TypeScript,
  whose `<` on a JavaScript string compares UTF-16 code units and disagrees with scalar order above
  the BMP (`docs/semantics.md` §2.3).
- **What it costs.** A binary is immutable and reference-counted like everywhere else in Erlang;
  `binary:part/3` is a view, not a copy, so `str.slice` is O(1) exactly as it is on Go's `string`.
  The one place a binary is *not* the cheap option is generic scalar iteration on a **non-ASCII**
  string (`str.codePoints`, `str.len` when ASCII is not proven): that needs a real UTF-8 decode,
  `unicode:characters_to_list/2`, and is priced as `allocating` in the capability table, the same way
  Go prices `[]rune(s)` for the same reason.
- **The alternative, and why it loses.** A list of code points (`[integer()]`) would make generic
  scalar operations (`str.codePoints`, pattern matching a `[H|T]`) marginally more idiomatic-looking,
  but it would make every ASCII-fast-path operation — the *overwhelming majority* of what these nine
  utilities actually do — an O(n) `lists:nth`, would need an encode pass before handing a value to
  any stdlib function that wants a binary (`re`, `binary`, `file`, `io`), and would make `str.compare`
  need an explicit scalar-by-scalar walk instead of one native comparison. Binaries lose nothing this
  project needs and win on every operation that is actually common.

### The loop and mutation story

This is the part that has no precedent in the other three targets, so it gets the full treatment
before any code: exactly what `forRange`, `forEach`, `break`, `continue`, an early `return` from
inside a loop, and a reassigned local each become, concretely.

**The scheme in one sentence:** every mutable local becomes a fresh Erlang variable on each
reassignment (single-assignment by construction, never Erlang's own — no shadowing), a loop becomes
a self-recursive named `fun`, and whatever statement sequence follows a loop, an `if` or a `switch`
is never stitched on afterward by the caller — it is compiled *into* every point control can still
reach normally: the loop's exhausted clause, every `break`, and the non-terminal arm of a branch. A
`return`/`fail`/`continue` never needs that treatment, because a value produced deep inside nested
`case` expressions is already the value of every expression around it the moment Erlang's own call
stack unwinds — there is no continuation-passing scheme, no tagged control-flow value threaded
anywhere, and nothing to get wrong about ordering, because nothing is *deferred*.

#### `forRange` and a loop-carried accumulator — `cpfCheckDigit`

Source (`core/source/lib/cpf.ts`, specialized for `size = 9`):

```ts
export function cpfCheckDigit(cpf: DigitsOf<11>, size: IntRange<9, 10>): IntRange<0, 9> {
	let sum: IntRange<0, 1000> = 0;
	for (let index = 0; index < size; index++) {
		sum += digitAt(cpf, index) * (size + 1 - index);
	}
	const remainder = sum % 11;
	return remainder < 2 ? 0 : 11 - remainder;
}
```

Generated (`core/out/erlang/lib_cpf.erl`, byte-identical to the committed file):

```erlang
cpf_check_digit(Cpf) ->
    Sum = 0,
    Bound = 9,
    Loop = fun Loop(Index, Sum1) ->
        case Index >= Bound of
            true ->
                Remainder = (Sum1 rem 11),
                (case (Remainder < 2) of true -> 0; false -> (11 - Remainder) end);
            false ->
                Sum2 = (Sum1 + (lib_digits:digit_at(Cpf, Index) * (10 - Index))),
                Loop((Index) + (1), Sum2)
        end
    end,
    Loop(0, Sum).
```

`sum` is the one loop-carried variable (`collectAssignedNames` finds it by walking the loop body for
`assign` targets); it becomes the `fun`'s second parameter, threaded through the tail call
(`Loop((Index) + (1), Sum2)`) exactly the way a hand-written accumulator loop is threaded in Erlang.
Everything the loop body reads but never reassigns (`Cpf`) needs no parameter at all — a named `fun`
is a real closure, so it is simply visible. The statement that followed the `for` loop in the source
(`const remainder = …; return …`) is not appended after a call to `Loop`; it is compiled *as* the
loop's exhausted clause (`Index >= Bound -> Remainder = …, (case … end)`) — there is no call site
left over to stitch it onto.

#### `forRange`, `break`, and an early `return` from inside a loop — `isRepeatedRun`

Source (`core/source/lib/digits.ts`):

```ts
export function isRepeatedRun(value: Digits): boolean {
	const first = value.charCodeAt(0);
	for (let index = 1; index < value.length; index++) {
		if (value.charCodeAt(index) !== first) {
			return false;
		}
	}
	return true;
}
```

Generated (`core/out/erlang/lib_digits.erl`, byte-identical to the committed file):

```erlang
is_repeated_run(Value) ->
    First = binary:at(Value, 0),
    Bound = byte_size(Value),
    Loop = fun Loop(Index) ->
        case Index >= Bound of
            true ->
                true;
            false ->
                case (not (binary:at(Value, Index) =:= First)) of
                    true ->
                        false;
                    false ->
                        Loop((Index) + (1))
                end
        end
    end,
    Loop(1).
```

The `return true;` that followed the loop becomes the *exhausted* clause's value (`true ->` reads
`true`, no accident of naming). The early `return false;` inside the `if` becomes that branch's
value directly — not a call to anything, not a tag, just the literal `false`, which is exactly what
the surrounding `case` expression evaluates to, which is exactly what the `Loop(...)` call the outer
function makes evaluates to, because that is what nested Erlang expressions *do*. No thread of
control was skipped or redirected to get there; the value was simply produced at the point it was
computed, the same as it would be in any expression-oriented language.

**`break` plus an accumulator** (not in either example above, but real, and in the capability table
by construction): `break` compiles to exactly the same thing the loop's own exhausted clause
compiles to — "whatever comes after the loop" — evaluated with whichever bindings are current at the
`break` rather than the loop's final ones. Concretely, for a loop over `xs` that accumulates into
`acc` and can `break`:

```erlang
Loop = fun Loop([], Acc1) ->
        Acc1                    %% exhausted: "what follows the loop", using the final Acc
    ;
    Loop([E | Tail], Acc1) ->
        case Cond of
            true -> Acc1         %% break: "what follows the loop", using *this* Acc — same shape
            false ->
                Acc2 = f(Acc1, E),
                Loop(Tail, Acc2)
        end
    end,
Loop(Xs, Acc0)
```

Both exit paths — falling off the end and breaking out early — produce the identical thing:
whatever comes next, evaluated with whatever the accumulator currently holds. That symmetry is not
a coincidence of this example; it is why `break` needed no separate mechanism (no tag, no second
"kind" of return value) once "what follows the loop" was already something every exit path could
just *evaluate directly* — this is the finding Stage 1 needed to reach before Stage 2 could start,
and it holds. There is nothing here that does not survive the translation.

### Feasibility verdict

**Sound, with the scheme above.** Every construct `docs/adding-a-target.md` and the checker's own
subset (`docs/semantics.md` §7) admit — `let mut`, `assign`, `setIndex`, `push`, `forRange`,
`forEach`, `break`, `continue`, early `return`, nested loops, a `switch` inside a loop, `Fail` — has
a concrete, sound Erlang shape, demonstrated above for the two hardest ones and exercised
exhaustively by conformance and the fuzzer (Stage 2, below). Stage 2 was built.

---

## Stage 2 — what was built

### Shape of the output

- One `.erl` file per source module (`-module(lib_cpf)` for `lib/cpf`), each compiled and loaded
  independently — Erlang has no single-package convenience the way Go's output does, so a
  cross-module call is qualified (`lib_digits:digit_at(...)`), computed from the same `TImport` data
  every other target's own import statement is computed from.
- A record is a plain `map()`; nothing is declared for it anywhere (no `-record`, no `.hrl`), which
  is what lets it cross a module boundary with no shared header at all — `printRecord` emits a
  comment documenting its shape for a reader, never Erlang source.
- A `Fail` effect is `errorsAsValues`, like Go: `{Value, nil}` on success, `{Zero, {'ErrorClass',
  Message}}` on failure. The atom `nil` is deliberate, not a Go-ism carried over by habit: it is
  exactly what the shared lowerer's `hoistFallible` (`backend/lower.ts`) hard-codes as `raw("nil")`
  for *every* `errorsAsValues` target, and `nil`, written bare, is already a perfectly ordinary
  Erlang atom — so that shared code needed no change at all to work here. The error tag is the
  domain error's own class name, quoted (`'GetAddressInfoByCepNotFoundError'`) so its `PascalCase`
  spelling is a legal atom and the differential driver's `atom_to_binary/2` reports it verbatim,
  matching the reference interpreter's own failure name exactly.
- `Erlang` has no conditional-expression problem the way Go does: `case Test of true -> …; false ->
  … end` is an ordinary expression, so `cond` never needs statement hoisting
  (`statementTernary: false`) and the pending-statement machinery `backend/lower.ts` built for Go is
  simply unused here.
- `seq.fold`/`seq.map`/`seq.filter` are declared loop combinators, so they become the same
  recursive-`fun` shape as a hand-written loop rather than needing their own capability-table
  entries — one mechanism, not two.
- `task.race` is one Erlang process per task, racing on messages, cancelling the losers with
  `exit(Pid, kill)` — the same shape Go's goroutines-plus-channel gets, in Erlang's own idiom.
- **No default `Capabilities`**, for the same reason as Go and Rust
  (`docs/decisions/0011-public-entry-points-vs-capabilities.md`): nothing in OTP's standard library
  is a drop-in HTTP client, clock or CSPRNG, so no wrapper is fabricated to imitate one. A
  capabilities value here is a `map()` of zero/one-argument closures
  (`#{request => fun(Req) -> … end, now => fun() -> … end, …}`) — the natural Erlang shape for "an
  interface" when there is no behaviour module to define one — and the differential driver's fake is
  the only place that builds one, exactly like Go's `cmd/driver`.

### The imperative-to-functional compiler

`engine/src/targets/erlang/index.ts`'s printer is not a per-statement `switch` the way the other
three targets' are: it is a small compiler (`compileStmts`/`compileExpr`/`compileFor`/
`compileForEach`), because turning statements into one nested expression is a real transformation,
not a syntax choice. The scheme:

- **`Ctx.versions`** is one monotonic counter per function. Every fresh Erlang variable — a `let`, a
  reassignment, a loop's own induction variable, a loop-fun's carried parameter, a `multiLet` name —
  is minted from it (`bind`), so `Sum`, `Sum1`, `Sum2`, … never repeats *anywhere in one function*,
  regardless of nesting. This is what keeps every generated name safe from Erlang's "variable
  shadowed" warning, which `erlc +warn_unused_vars +warnings_as_errors` treats as a build failure —
  see "What the fuzzer found" for the two real bugs that were found by relying on something less
  than this guarantee.
- **`fallOff`/`onBreak`/`onContinue`** are the three continuations `compileStmts` threads through.
  `fallOff` is "normal completion of *this* statement list" and is rebound at every level of nesting
  (each `if`/`switch` branch gets its own, meaning "whatever follows that construct"). `onContinue`
  is deliberately *not* rebound by `if`/`switch` — it always means "next iteration of the innermost
  loop", which is why it needs its own reference passed down unchanged rather than reusing whatever
  `fallOff` happens to be at the point a `continue` is written; conflating the two was the first real
  bug the fuzzer found (below). `onBreak` is threaded the same unchanging way, and compiles to
  exactly the loop's own "what follows" continuation.
- **A candidate's `raw` fragment carries plain, unversioned names** (`print`, the stateless
  printer used only inside `emit` functions, since SSA state does not exist yet when a candidate
  runs during `lowerProgram`). `compileExpr`'s `"raw"` case is where that text is rewritten: once for
  the live SSA name of every variable it mentions (`substituteEnv`), once for the module that
  actually defines every function it calls (`qualifyCalls`), once for a reference to a hoisted
  constant table (`resolveConstants`) — the same word-boundary rewrite technique the Python backend's
  own `applyPrivacy` already uses on its own `raw` fragments, for a different rename.
- **A hoisted constant table** (`hoistConstantTables` in the shared lowerer) has nowhere to live at
  module scope the way it does in every other target — Erlang has no module-level binding except a
  function. It becomes a zero-argument function, `'LibCnpjTable1'() -> [5, 4, 3, …].`, quoted because
  its `PascalCase` name (the same `naming.value` every local gets) is otherwise only legal as a
  variable; every read of it becomes a call, `'LibCnpjTable1'()`.
- **`suppressUnusedBindings`** is the one pass, run once per function over the *finished* text, that
  decides every "is this name actually used" question — for a `let`/`assign` that turns out to be a
  dead store, and for every loop-fun, lambda or top-level parameter alike, uniformly, rather than at
  the point each is printed. It is a fixed point (up to 50 rounds, converges in far fewer in
  practice): a name occurring exactly once in the text is exactly its own declaration and nothing
  else, and when its value expression provably calls nothing (`isPureExpr` — no lowercase-identifier
  call, no quoted-atom call, the only two shapes a call ever has in this printer's own output), the
  whole line is deleted rather than merely renamed to `_Name`, because deleting it is what can make
  an *earlier* binding dead in turn — see "What the fuzzer found" for why a rename alone does not
  fully satisfy `erlc`.

### What the fuzzer found

Three real bugs, found by `fuzz.ts full --targets erlang`, none of them present in the four existing
targets because none of them needs any part of this scheme:

1. **A synthetic loop-carried name colliding across nested loops.** `forEach`'s tail pattern
   variable was originally looked up in `env` by the fixed key `"Tail"` — but `env` is a shared-key
   map, and a *nested* `forEach`'s own `"Tail"` binding shadowed the outer loop's, so the outer
   loop's own tail call picked up the inner loop's tail variable instead of its own once compilation
   returned from the inner loop's scope. The fix: capture the minted parameter name directly as a
   closure variable at the point the loop is compiled, never through a shared-key lookup — real
   Core-level names (an accumulator reassigned by both an outer and an inner loop) are correctly
   shared through `env`, because they really are the same variable; this synthetic one never was.
2. **A named `fun`'s self-reference counted as "unused" even though the value it is bound to is
   called.** `Loop = fun Loop(I) -> I + 1 end, Loop(5)` warns `variable 'Loop' is unused` under
   `erlc +warn_unused_vars`, confirmed directly against `erlc` — a loop whose every path is terminal
   (never actually recurses) never references its own self-reference name, and Erlang tracks that
   occurrence separately from the outer binding's own use. Fixed by underscoring only the
   self-reference (`fun _Loop(...) -> ... end`) when the compiled body provably never calls it back,
   leaving the outer binding's real name untouched.
3. **A binding used only by an otherwise-dead binding.** `Acc4 = ((E rem 7) =:= -2), _Acc5 = (not
   Acc4)` — `Acc4` has a genuine syntactic read (inside the line that computes `_Acc5`), so it is not
   "unused" by the simple one-name-one-count rule, but `erlc`'s own dead-value analysis traces
   *through* the now-unused `_Acc5` and warns on `Acc4`'s own operators anyway
   (`the result of evaluating operator 'rem'/2 is ignored`), and renaming `Acc4` does not silence it
   — confirmed directly against `erlc`, a plain rename leaves the warning exactly where it was; only
   deleting the line does. This is why `suppressUnusedBindings` deletes a dead, provably pure binding
   outright instead of merely underscoring it, and iterates to a fixed point rather than running
   once: deleting `_Acc5`'s line is what makes `Acc4` provably dead in turn, one round later.

All three are now covered, directly, by the design (not worked around after the fact): the fixed
point in `suppressUnusedBindings`, the closure-capture rule for synthetic loop state, and the
self-reference check are each a general property of the compiler, not a patch for one shape.

### Determinism, with no formatter

No Erlang formatter exists in this toolchain — no `rebar3` (the task's own setup note), and
`erlfmt` is not installed. `verify`'s determinism check (`cli.ts build` run twice, diffed) still
holds, because the printer's own output already has the property a formatter would otherwise be
responsible for: fixed, explicit indentation (`indent`, four spaces per level, applied by the
compiler itself rather than left to a post-pass), no trailing whitespace, and no output that depends
on iteration order over anything unordered (`Ctx.versions`/`Ctx.allBound` are insertion-ordered
`Map`/arrays, walked in the same order every run for the same input). If a formatter becomes
available later, running it once and re-committing is a one-time diff, not a design change.

### What was left out

- **`Float`.** No utility in `core/source`, and no shape the fuzzer generates, ever produces a
  `Float` value — `docs/semantics.md`'s own admission rule (§8) is "at least two utilities need it,
  or write it in source", and none do. Adding it would mirror the `Int` candidates exactly
  (`+`/`-`/`*`/`/` native, comparisons native) with no representation question at all, since
  Erlang's `float()` is already IEEE-754 binary64; there is nothing target-specific to work out, so
  it was left for when a caller actually needs it rather than spun up speculatively.
- **`str.concatAll`.** Only Rust declares this (flattening a chain of `+` into one allocation,
  because Rust's `String` concatenation is the one place repeated pairwise concatenation is
  expensive enough to matter — `docs/targets/rust.md`). Erlang's `str.concat` builds a nested binary
  view (`<<A/binary, B/binary>>`), which costs nothing extra per link the way a reallocating buffer
  would, so the pairwise path Rust needed help avoiding was never a problem here.
- **A default `Capabilities`.** Covered above, under "Shape of the output" — the same documented gap
  Go and Rust have, not an oversight.

Everything the nine utilities in `core/source` actually call — every row in
`core/out/erlang/LOWERING.md` — has an entry. Nothing was approximated to make a case compile; where
a lowering was not sound (there were none, in the end), the plan was to record it here rather than
invent one, per the project's own rule.
