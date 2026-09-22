# Target: F# (.NET)

**Baseline** F# 8 / .NET 8, `dotnet new console -lang "F#"` and nothing more.
**Dependencies** none — standard library (`FSharp.Core` + BCL) only.
**Formatter** none: `dotnet format` supports only C# and Visual Basic projects (verified against the
installed 8.0.131 SDK — see "Formatting" below), so the printer's own output has to be the
committed byte shape, not a formatter's.
**Linters** `dotnet build -warnaserror` (F# emits real warnings for an unused binding, an incomplete
match, a shadowed open, etc.; treating them as errors is this target's `staticcheck`/`clippy`).

## Representation

| Semantic type | F# |
|---|---|
| `Int[lo..hi]`, `Decimal<S>`, `CivilDate`, `Instant`, `Duration` | `int64` |
| `Float` | `float` (`System.Double`) |
| `String`, `Ascii`, `Digits` | `string` (`System.String`, UTF-16) |
| `List<T>` | `ResizeArray<T>` (`System.Collections.Generic.List<T>`) |
| `Option<T>` | `T option` |
| `Record` | an immutable record type (`{ Field: T }`, no `mutable` fields) |
| `Enum` | `string` |
| `Lambda` | a plain function value (`'a -> 'b`) |

### Integers: `int64` uniformly, no `bigint` fallback

This is the same choice Go and Rust already made, and for the same reason. The engine's own
admission rules bound every range that can actually reach a backend:

- a bare `Int`/`number` is the *platform-safe domain*, ±(2^53 − 1) — chosen precisely because it is
  what every target's native integer represents exactly;
- every collection length and every index derived from one is bounded by `MAX_COLLECTION_LENGTH`
  (2^31 − 1);
- every explicit `IntRange<lo, hi>` in this project's source and standard library
  (`IntRange<-4000000, 4000000>`, `IntRange<1, 146097>`, `IntRange<-719162, 2932896>`, `IntRange<0,
  1114111>`, …) sits well inside ±(2^53 − 1) too — nothing in `core/source` or `engine/stdlib`
  writes a wider one.

`int64` covers ±(2^63 − 1), a wide margin over ±(2^53 − 1), so it represents every value this
engine's checker can prove for `Int`, `Decimal`'s unscaled integer, `CivilDate`'s and `Instant`'s
day/millisecond counts, and `Duration`, with room to spare — exactly the same margin Go's assumed
64-bit `int` and Rust's `i64` already rely on. No candidate in the capability table below gates an
integer operation on a range fact, because there is no admission path in this engine that can ever
produce a range `int64` does not cover; if one is added later (an intrinsic proven only over a
range that leaves ±(2^63 − 1)), it is a compile error today — there is no `bigint`/`System.Numerics.
BigInteger` lowering in this table, by the same reasoning Go's own doc gives.

`int64`, not `int` (32-bit): `int` cannot represent `MAX_COLLECTION_LENGTH` (2^31 − 1) itself, let
alone an index derived from one plus one, so it was never in consideration.

**One friction `int64`-everywhere forces, that none of Go/Python/TypeScript face the same way**:
every .NET collection and string indexer (`ResizeArray<T>.Item`, `string.[i]`, `.Count`, `.Length`)
takes and returns .NET's 32-bit `int`, never `int64`. Every index expression this target prints is
therefore wrapped with an explicit `int` (truncating int64→int32) and every `.Count`/`.Length` read
is wrapped with `int64` (widening back) — sound precisely because `MAX_COLLECTION_LENGTH` (2^31 − 1)
*is* `System.Int32.MaxValue`, so the conversion never truncates a real length or a real proven-in-
range index. This is invisible in the generated output (it is exactly where a hand-written F#
program indexing a `ResizeArray` with a 64-bit counter would put the same cast), but it is a real,
per-operation detail this backend's `seq.*`/`str.*` candidates all have to get right that Go's own
64-bit `int` slices, Python's arbitrary-precision `int`, and Rust's `usize`-taking `Vec` (already a
second integer width Rust's own backend threads through, by its own docs) do not share in quite the
same shape.

### Strings: UTF-16, so "index" means what it means in TypeScript

.NET's `System.String` is a UTF-16 code unit sequence, exactly like JavaScript's `string` — verified
directly (`"\U0001F600".Length` is `2`, not `1`, on the installed SDK). This is the *same*
precondition `docs/semantics.md` §2.3 and `engine/src/targets/typescript/index.ts` already reason
about, not a new one:

- `str.len` is native (`value.Length`) only on a proven-`Ascii` argument, where a UTF-16 code unit
  count equals a scalar count; otherwise it is the portable scalar count
  (`value.EnumerateRunes() |> Seq.length`, .NET's own code-point iterator, the exact analogue of
  JavaScript's `[...s].length`).
- `str.codeAt`, `str.charAt`, `str.slice`, `str.codeAtOpt`, `str.charAtOpt` and `str.indexOf` are
  native only on `Ascii`, where a UTF-16 index is a byte-for-byte, scalar-for-scalar position —
  `E_UTF16_POSITION` already refuses these on an unproven string at the frontend, so the backend
  only ever has to lower the ASCII case.
- `str.compare` is native (`System.String.CompareOrdinal`, normalized to −1/0/1) only when both
  operands are proven `Ascii`. Ordinal comparison in .NET orders by UTF-16 code unit exactly like
  JavaScript's `<`, so an unproven pair uses the same portable `std/strings::compareScalars` every
  other target falls back to.
- `str.asciiUpper`/`str.asciiLower` use `.ToUpperInvariant()`/`.ToLowerInvariant()` only on a
  proven-`Ascii` argument (`ToUpperInvariant` still runs full Unicode case folding — "ß" → "SS" —
  outside ASCII, the same gap `docs/semantics.md` §2.3 documents for JavaScript's `toUpperCase`);
  the unproven case is a one-pass `String.map` over UTF-16 chars that only ever touches `a`-`z`/`A`-
  `Z` and leaves every other code unit — including each half of a surrogate pair — untouched, which
  is sound for the same reason Go's `strings.Map` restricted to ASCII ranges is (`docs/progress.md`
  §8): a surrogate half is always outside `a`-`z`/`A`-`Z`, so it always fails the test and is
  reproduced unchanged, reassembling the same pair.
- `str.codePoints`/`str.fromCodePoints` use `System.Text.Rune` (`.EnumerateRunes()` to decode,
  `Rune(point).ToString()`/a `System.Text.StringBuilder` of runes to encode), .NET's own code-point
  API, native and unconditional — the same operation `str.codePoints`' non-ASCII fallback needs.
- `.Contains`/`.StartsWith`/`.EndsWith` are always called with `StringComparison.Ordinal` explicit.
  Unlike the length/index family this is not a proof-gated choice — no argument's class changes
  which overload is correct — but it *is* a real .NET-specific trap worth naming here: the
  parameterless overloads of `StartsWith`/`EndsWith` compare using the *current culture*, which is
  neither ordinal nor deterministic across machines. `Contains(string)` already defaults to ordinal,
  so it is unaffected, but the code always passes the comparer explicitly for all three, so a reader
  never has to know which of the three defaults which way.

### Regex: reusing the shared `"javascript"` dialect, with a documented gap

`System.Text.RegularExpressions.Regex` accepts `\uXXXX` for a code point up to `U+FFFF` — verified
directly — exactly what `regex.ts`'s `"javascript"` dialect prints for every scalar in that range,
so `printRegex(node, "javascript")` is reused as is; anchoring is `\A…\z`, compiled once per pattern
at module load (`Regex.IsMatch` recompiles from source text on every call with no cache, the same
79.6×-measured defect Go's `regexp.MustCompile` hoisting avoids — `docs/adding-a-target.md`).
.NET's regex engine does **not** accept `\u{…}` (verified: `Invalid pattern … Insufficient or
invalid hexadecimal digits`), which is what the shared dialect emits for a scalar above `U+FFFF`.
Every regex in `core/source` (the CPF/CNPJ/CEP masks) and every vector in `engine/stdlib` stays
inside the BMP, so this never fires today; it is recorded here, not silently worked around, because
the moment a pattern needs a scalar above `U+FFFF` the `"javascript"` dialect's output stops being
valid .NET regex syntax and a real fix (a fourth dialect in `regex.ts`, printing a UTF-16 surrogate
pair as two `\uXXXX` escapes — verified to match .NET's own encoding of the input) is owed instead
of a workaround inside this target.

**A second, narrower .NET-specific gap was not anticipated — it was found by conformance failing**:
the CPF and CNPJ mask patterns both have a class range whose low end is the hyphen itself (matching
`.`, `-` and `/` as mask separators), which the shared dialect spells `\--/` — `\-` (escaped, since
a bare `-` here would misparse as opening a range) immediately followed by the range operator's own
`-`. JavaScript, Python and RE2 all read this as the range `[0x2D-0x2F]`. .NET does not: verified
directly, `Regex(@"[\--/]")` matches `-` and `/` but not `.`, the scalar between them, while
`Regex(@"[\x2d-/]")` (the same range, spelled with a hex escape instead) matches all three. This
target's `re.test` candidate rewrites exactly that one three-character sequence, `\--`, to `\x2d-`
before handing the pattern to `Regex` — the hyphen is otherwise never a range's low end anywhere
else in this project's patterns, but the rewrite is unconditional and total, not special-cased to
CPF/CNPJ, since nothing but this exact shape ever produces that sequence. `re.retain`'s own native
lowering never goes through `printRegex` at all (it reads the normalized `CharRange`s directly, the
same way the ASCII byte-range scan in Go's `re.retain` does), so it was never exposed to this.

### Lists: `ResizeArray<T>`, matching the mutable-imperative choice below

A Core `List<T>` is mutable while it is being built (`push`) and is documented as "frozen when it
escapes its construction scope" — a discipline the *source* enforces, not a distinction any of the
four existing targets represent in their own type system (Go's `[]T`, Python's `list`, TypeScript's
`T[]`/`readonly T[]` are both the mutable-build type and the escaped type, just spelled two ways in
TypeScript's case). `ResizeArray<T>` is .NET's own `List<T>`: O(1) `Add` (`push`), O(1) indexed
access, and the type every idiomatic F# author reaches for when a list is *built* imperatively
rather than assembled by `List.map`/`::`. An F# `'T list` (the cons-cell list) was rejected for
exactly the reason `Vec`, not a `Cons` list, was for Rust: `push`, indexed access and the loop
bodies this target renders all want O(1) at the operation the source actually performs, and a
singly-linked list makes `seq.push` (append) O(n) and `seq.get` at an arbitrary proven-in-range
index O(n) as well, which is a materially different cost profile than every other target declares.

## The mutable-vs-functional decision

**F# renders the Core IR's imperative shape directly: `let mutable` locals, native `for`/`for … in
… do` loops, and — the one departure, argued below — nested `if`/`then`/`else` *expressions* for
early return that never crosses a loop boundary.**

The source subset (`docs/semantics.md` §7) is already imperative: `let`/`let mut`, counted `for`,
`for…of`, `break`, `continue`, early `return`, `push` on a local list. Every existing target renders
that shape close to literally — Go and Rust with real loops and mutable locals, Python with `for`
loops plus comprehensions only where a single-expression body makes one read naturally. F# is
functional-first by *convention*, but it is not functional-only: `for`, `while` and `System.
Collections.Generic.List<T>` are ordinary, unexceptional F#, and choosing them keeps this target
consistent with the other four instead of being the one generated language whose control flow
structurally diverges from what the Core IR says the program does. The alternative — folding a loop
into `Seq.fold`/`List.fold`, turning an accumulator into a fold's carried state — was rejected for
the same reason the engine's own `loopCombinators` mechanism exists at all: `seq.fold`/`seq.map`/
`seq.filter` are declared as loop-preferring here (`loopCombinators: {fold, map, filter}`, the same
set Go declares), so the two or three actual combinator call sites in this project's source render
as loops too, and nothing in the generated output is a fold.

**`break` and `continue` have no expression form in F# at all — the language deliberately left them
out** (unlike C#, which has both). A generated loop that contains one cannot be a `while` loop with
a boolean exit test the way Go's or Rust's can; F#'s `for`/`for…in…do` has no arity for "stop early"
either. The rendering chosen here is **the loop always runs its full, checker-proven trip count**,
guarded by a boolean sentinel local scoped to that one loop:

```fsharp
let mutable brk1 = false
for holiday in getHolidays year do
    if not brk1 then
        let mutable cont1 = false
        if not includeOptional && holiday.Type = "optional" then
            cont1 <- true
        if not cont1 then
            // …
```

`break` sets the loop's own `brk` sentinel (checked, never cleared, so every later iteration's body
is skipped); `continue` sets a `cont` sentinel that is *re-declared* — not just reset — at the top
of every iteration, which is what makes it iteration-scoped for free. Nothing is actually
short-circuited: a `break` on iteration 3 of a 90-element list still visits elements 4 through 90,
each one testing an already-`true` boolean and doing nothing. Every loop this project's utilities or
its fuzz-generated corpus ever builds is bounded by the checker's own admission rule (`docs/
semantics.md` §2.2 — a proven trip count, and the fixed-length lists this codebase iterates over are
small), so this is not a hidden asymptotic cost, only a constant number of extra boolean tests a
JIT trivially predicts — the same trade the "run to completion" idiom always makes, and the reason
it is a recognized F# pattern for early-exit loops (the language's own answer to "F# has no
`break`") rather to reaching for `System.Exception` as control flow, which would be the actually
non-idiomatic choice here. A sentinel is allocated **only for the loops that need it** — a loop
whose body has no `break`/`continue` (the common case: `getHolidays`, `groupThousands`, most of
this codebase) prints as a plain `for … do` with no sentinel and no extra checks at all, so reaching
for the mechanism is a printer-level decision made once per loop, from what that loop's body
actually contains, not a blanket transform applied everywhere.

**Early `return` is handled two different ways, chosen per function, and this is the one place this
target's printer does real work beyond direct transliteration.** A guard-clause chain that never
enters a loop —

```fsharp
if year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 then
    None
else
    let days = daysFromCivil year month day
    if yearFromDays days <> year || monthFromDays days <> month || dayFromDays days <> day then
        None
    else
        Some days
```

— is F#'s own *direct functional form* for "return early": `if cond then value else rest`, because
`if`/`else` is an expression in F#, not a statement, and this is exactly how an F# author writes
`ymdToDays` by hand. The printer builds this by continuation-passing over the statement list: each
`if` with no `else` becomes `if test then <lower(then, tail)> else <lower(rest-after-this-if, tail)>`,
recursively, with the outermost `tail` being unreachable (the checker already proved every path
returns). This is not a special case for "the last statement is a return" — it composes through
nested, partially-terminal `if`s exactly like `isValidCnpj`'s does, where the `if (version === "2")`
branch only *conditionally* returns and the rest of the function has to run when it does not.

A `return` reached from **inside a loop** — `compareScalars`, `jsonStringField`, `isBusinessDay` all
have one — cannot use this expression form: a loop's body is not an expression this engine renders
(the section above), so nothing is available to plug into an `if`/`else`'s branch. This is where the
one piece of real mutable state in this target's rendering appears: **the moment any loop in a
function can reach a `return`, the whole function switches, uniformly, to a `__result`/`__returned`
pair** —

```fsharp
let mutable __result = Unchecked.defaultof<_>
let mutable __returned = false
// every statement list in the function, including ones outside any loop, is now wrapped:
// `if not __returned then <it>` for whatever follows a statement that could have set it,
// and `return v` becomes `__result <- v; __returned <- true`.
__result
```

guarding not just that loop's body but *every* statement anywhere in the function that follows a
point where a return could already have fired — including a guard clause that comes lexically
before the loop, which would otherwise have used the expression form on its own. **This is a
deliberate uniformity trade, not a limitation forced by the language**: a function could keep its
pre-loop guard clauses in expression form and only switch to the sentinel once it reaches the loop,
composing the two styles inside one function body. That was rejected because it makes the printer's
own two rendering strategies visible in the *generated* code — a reader would see one function open
with clean nested `if/else` and then, three lines later and for no reason visible in the function's
own logic, switch to mutable flags — which reads like an artifact of how the code was generated
rather than a choice an F# author would make. A single, function-scoped decision — "does *any* path
through this function pass through a loop before it can return" — is legible on its own terms, and
it costs nothing in the common case: **most functions in this project have no loop at all, or no
loop that returns, and print with no `__result`/`__returned` machinery whatsoever** — `ymdToDays`,
`isValidCpf`, `isValidCnpj`, `formatCnpj`, `formatCurrency`, `cpfCheckDigit`, `cnpjCheckDigit`,
`easterDayOfMarch`, `groupThousands`'s sibling `patternSlots`, `civilDate`, `getHolidays` — none of
these ever allocate a sentinel of either kind. Only the ones that actually need it —
`compareScalars`, `jsonStringField`, `isBusinessDay`, `formatWithPattern`, `generateCpf`,
`generateCnpj`, `randomBelow` — do, and only those that also have a loop-scoped `break`/`continue`
inside that machinery get the `brk`/`cont` sentinels on top of `__returned`.

This mirrors the tension the task names directly for the Erlang target working in parallel: neither
`break` nor an imperative early `return` has a native expression form in a functional-first
language. The choice recorded here is to solve it exactly once, uniformly, with the smallest amount
of state each shape actually needs, rather than inventing per-callsite tricks — and to keep it out
of the generated code entirely wherever the source's own control flow does not force it.

## Effects and capabilities

- `Fail<E>` is an ordinary .NET exception hierarchy (`errorsAsValues: false`, like TypeScript and
  Python, not Go): `exception DomainError of message: string` at the root — spelled as a class
  (`type DomainError(message: string) = inherit System.Exception(message)`), not F#'s lightweight
  `exception` keyword, because the latter cannot express `error.base` (a declared error may extend
  another declared error, not only the root) and .NET's own `is`/pattern-matching on exception
  types is exactly the mechanism `errors.Is`/`errors.As` give Go — a `try … with :? SomeError -> …`
  reads it the same way.
- **F# builds a default `Capabilities`, like TypeScript and Python, unlike Go and Rust**: .NET's
  standard library ships `System.Net.Http.HttpClient`, `System.DateTimeOffset.UtcNow` and `System.
  Security.Cryptography.RandomNumberGenerator`, so a utility whose effects reach `Http`, `Clock` or
  `Random` gets the public-wrapper-over-a-seam split `docs/semantics.md` §4.1 describes:
  `getAddressInfoByCep` keeps its exact published signature and calls `getAddressInfoByCepWith`
  (the seam) with the module-level `defaultCapabilities`, built once.
- `task.race` is one `System.Threading.Tasks.Task` per branch, started with `Task.Run`, and the
  first one to answer `Some` wins — `Task.WaitAny` in a loop over the still-pending tasks, exactly
  Go's "one goroutine per task, first non-nil off a channel" translated to .NET's own concurrency
  primitive. Cancellation is best effort and unobserved, per `docs/semantics.md` §4.2: a losing
  task's `Task` is not cancelled, only its result is never read.
- `asyncColouring: false`. .NET has real `async`/`Task` machinery, but every capability call in this
  engine's model is a single blocking round trip inside a function that is otherwise synchronous
  arithmetic, and `task.race` is the *one* place concurrency is actually needed — handled directly
  with `Task.Run`/`Task.WaitAny` rather than colouring every caller `async` the way TypeScript does
  for a single-threaded event loop that actually needs it. Go, Python and Rust all made the same
  call for the same reason: the concurrency here is real OS threads doing a real (if fake, in the
  driver) network wait, not cooperative scheduling that a colouring scheme exists to serve.

## Shape of the output

- One F# project, `Core.fsproj`, one `.fs` file per source module plus `Errors.fs` and `Support.fs`,
  **listed in `<Compile Include>` order** — unlike Go's single package (order-independent) or
  Python/TypeScript's per-file imports, F# requires every name a file uses to have been declared in
  an *earlier* file of the same project. The generated `.fsproj`'s file order is a topological sort
  of the cross-module call graph (`Errors.fs` and `Support.fs` first, since nothing they declare
  depends on generated code), computed from the same reachable-function set `analysis/capabilities.
  ts`'s `dependencyClosure` already gives every other target, broken by module path for determinism.
- A source module's own `export` decides F#'s own `[<AutoOpen>]`-free visibility: everything is
  declared in its module's namespace (`module Core.IsValidCpf`), a helper the source never exported
  is `let private`, and a utility is `let` (public) under a `[<CompiledName>]`-free PascalCase name
  matching what `API.json` documents.
- A record is an immutable F# record (`{ Cep: string; State: string; … }`), never a class — the
  source's own "nominal, immutable, declared with `type X = { … }`" translates directly, and F#
  records already have structural equality, which the differential driver's JSON round trip never
  needs but a hand-written caller benefits from for free.
- `Support.fs` holds `Capabilities`/`HttpRequest`/`HttpResponse`, the default environment
  (`HttpClient`-backed), `raceFirstSome`, and the small helpers the capability table names
  (`padStart`, `asAscii`, `asDigits`, `parseDigits`, `compareInts`, …) — the same role Go's
  `support.go` and Python's `_support.py` play.
- Domain errors are in `Errors.fs`, one exception class per declared error, `DomainError` at the
  root.

## Capability table: what is deliberately left out

Every intrinsic the nine utilities and `engine/stdlib` actually use has a native or portable
lowering (see `LOWERING.md` once generated). Left out, on purpose, with no admissible candidate at
all — the same "a missing entry is a compile error naming the operation" contract every other
target's partial table already relies on:

- **None.** Unlike Go and Rust (no HTTP client, no regex engine in the standard library at all),
  .NET's BCL is a strict superset of what every capability and every string/regex/date/decimal
  operation in this engine's model needs, so there is no intrinsic this target has to refuse for
  lack of a sound lowering. Where a target-specific *gap* exists, it is recorded above as a
  precondition (ASCII-gated string operations, the BMP-only regex dialect) or a documented
  assumption (`int64`'s range), never as a missing capability-table entry.

## Formatting and warnings

`dotnet format` (8.1.661101, bundled with the 8.0.131 SDK) refuses an `.fsproj`: "Format currently
supports only C# and Visual Basic projects" (verified directly against a scratch `dotnet new console
-lang "F#"` project). There is therefore no formatter step for this target in `verify.ts` — instead,
the printer is written to produce the exact, stable, already-indented byte output on every run
(tabs, one blank line between top-level bindings, no trailing whitespace), and `verify`'s
determinism step (regenerate and diff) is what actually proves that promise instead of a formatter's
idempotency. The build step passes `-warnaserror`, so an unused `open`, an incomplete pattern match
or a shadowed binding — the things `gofmt`/`staticcheck` or `rustfmt`/`clippy` would also catch —
still fail `verify` instead of silently drifting.
