# Target: Ruby

**Baseline** Ruby 3.2 (`Data.define` is what makes an immutable record type clean; the installed
toolchain measured against is 3.3.6). **Dependencies** standard library only (`net/http`, `uri`,
`json`, `securerandom` is not even needed — see Randomness below). **Formatter/linter**
`standardrb` (Standard Ruby, pinned at 1.43.0 in `toolchain.lock.json`), one command for both: see
"Formatter and linter are one tool" below.

## Representation

| Semantic type | Ruby |
|---|---|
| `Int[lo..hi]` | `Integer` |
| `Float` | `Float` |
| `Decimal<S>` | `Integer` holding the unscaled integer |
| `String`, `Ascii`, `Digits` | `String` (always UTF-8; see Strings below) |
| `List<T>` | `Array` |
| `Option<T>` | the value itself, or `nil` |
| `Record` | `Data.define(...)`, an immutable value object with structural `==` |
| `Enum` | plain `String` |
| `CivilDate`, `Instant`, `Duration` | `Integer` |

## Integers

Ruby's `Integer` is arbitrary precision, exactly like Python's `int`, so — as in Python — a proven
range never forces a different representation. There is no fixnum/bignum distinction visible from
generated code: Ruby promotes silently and unconditionally at the language level, so nothing in
this backend has to special-case a `Int` whose range would overflow a 64-bit machine word the way
the Go backend has to refuse one.

This has one consequence worth being explicit about, the same one Python's doc calls out: `Int`
with no annotation means the platform-safe domain, ±(2^53 − 1) (`docs/semantics.md` §2.1) — the
range every *other* target's default integer represents exactly. Ruby's own default integer
represents a far wider range than that exactly too, so the platform-safe domain is not a limit
Ruby's representation needs at all; it is a limit the **source language's own analysis** imposes
uniformly, so that a bare `number` means the same provable thing whether it is heading for
JavaScript's `number`, Go's 64-bit `int`, or Ruby's unbounded `Integer`. A backend that happened to
widen this on its own — accepting a bigger range than the published contract promises — would make
a value that is safe in Ruby silently unsafe the moment the same source is regenerated for Go. The
engine deliberately does not let a target's own headroom leak into what the *type* means: Ruby's
`Int[lo..hi]` is exactly the same proven range TypeScript's, Python's and Go's are for the same
source, and every target simply picks a representation it can prove safe for that range (§9 of
`semantics.md`) — Ruby's answer to that question is always "yes, `Integer`, unconditionally,"
which is what the representation table above says.

## Strings

A `String` is always UTF-8 in generated code: every literal this backend prints is escaped into
`\u{...}` for anything outside printable ASCII (see "String literals" below), and every method
this backend selects for a `String` operand is one whose result is defined in terms of Ruby's own
character (Unicode scalar) model, not bytes. This matters because Ruby's `String` is not
inherently one encoding — a `String` read from a file or a socket can carry any encoding tag — but
every `String` this compiler ever produces is one it built itself, so that ambiguity never reaches
generated code.

Given that, `String#length` counts Unicode scalars — exactly the Core's definition of length, the
same fact Python's `len()` already gets from being scalar-indexed. `String#[]` is *also*
scalar-indexed for **any** string, not only an ASCII one: Ruby has no separate "position" concept
that disagrees with the scalar index above U+007F the way JavaScript's UTF-16 code unit or Go's
byte offset does. `String#<=>` compares byte by byte in the UTF-8 encoding, which is monotonic
with scalar value — comparing two valid UTF-8 byte sequences byte-by-byte gives exactly code point
order — so it answers scalar-order comparison directly, and as an actual `<=>` (a "spaceship") it
already returns -1/0/1, the exact contract `str.compare` wants, with no manual `if`/`else` chain
needed the way Python and the other three targets write one.

This is *stronger* than what the Core's ASCII proof requires, and it means the story here is not
"Ruby is only conditionally equivalent, gated the same way Python is" — several of the lowerings
this backend selects are strictly less conditional than Python's own choices for the same
operation (`str.indexOf`, `str.contains`, `str.startsWith`, `str.endsWith`, `str.compare` are
native and **unconditional** here, where Python's own table still gates `str.indexOf` on
`argIsAscii`). What stays gated on the ASCII proof — `str.charAt`, `str.codeAt`, `str.slice`,
`str.charAtOpt`, `str.codeAtOpt` — is gated because the **frontend itself** only ever offers these
ops an ASCII-proven argument (`E_UTF16_POSITION`, `docs/semantics.md` §2.3): the checker's
"position" restriction exists for the sake of the *other* three targets' genuine disagreement above
U+007F, and it applies uniformly regardless of which targets exist, so this backend documents the
same precondition Python's and Go's tables do even though Ruby's own `String#[]` would already be
sound without it. If a future target only Ruby has to agree with joined the project, this
precondition on *these five ops specifically* could in principle be lifted at the frontend level —
but that is a frontend change, out of scope here, and not one this backend can make unilaterally
without breaking what "ASCII-proven" is supposed to mean for the targets that still need it.

Two genuine Ruby-specific gaps, not present in Python, are worth naming plainly:

- **`String#[]`/`Array#[]` answer `nil`, not an empty value, when a range's *start* is past the
  end.** `"abc"[5...10]` is `nil` in Ruby; the Core's `str.slice`/`seq.slice` are defined as total
  (clamped to the length, never absent — `docs/semantics.md`: "clamped to its length"). Python's
  `s[a:b]` has no such gap (an out-of-range Python slice is always `""`, never `None`), so this is
  a real divergence Python's own doc never had to mention. `str.slice`/`seq.slice` are therefore
  `library`, not `native`, lowered to a small clamping helper (`str_slice`/`seq_slice` in
  `_support.rb`) rather than the bare `value[a...b]` a naive port would write.
- **`String#split` drops trailing empty fields by default, and answers `[]` rather than `[""]`
  for an empty receiver.** `"a,b,,".split(",")` is `["a", "b"]`, and `"".split(",")` is `[]`,
  where the Core's `str.split` (defined against JavaScript's `String#split`, which the interpreter
  actually calls) wants `["a", "b", "", ""]` and `[""]` respectively. Passing an explicit negative
  limit (`split(sep, -1)`) fixes the first; the second needs an explicit empty-receiver check.
  Both live in `str_split` in `_support.rb`.

## Case mapping: `String#tr`, a one-pass transliteration with no folding table

`str.asciiUpper`/`str.asciiLower` map `a`-`z`/`A`-`Z` and leave every other scalar alone, by
definition (`docs/semantics.md` §2.3) — deliberately *not* full Unicode case folding, because the
targets disagree on that above ASCII. Python and Go both need **two** candidates for this: a cheap
one gated on the ASCII proof (their host's `.upper()`/`.upper()`/`ToUpper` *is* full Unicode
folding, which only coincides with the ASCII-only definition when the input has nothing outside
ASCII to fold) and a slower, portable fallback for anything not proven ASCII.

Ruby needs exactly **one**, unconditionally: `String#tr("a-z", "A-Z")` is a literal, per-character
transliteration table with no folding logic in it at all — it maps the scalars in its source set to
the corresponding scalars in its target set and leaves everything else untouched, which is *by
construction* the same operation `str.asciiUpper` is defined to be, on any input, proven ASCII or
not. There is no second, slower candidate to fall back to here, because there is nothing the first
one fails to handle.

## Sorting: no stability guarantee, so decorate/sort/undecorate

`Array#sort` and `Array#sort_by` are not specified stable in Ruby (unlike Python's `sorted`, which
is), the same problem Go's own unspecified `sort.Slice` has — Go's answer is
`slices.SortStableFunc`; Ruby's standard library has no stable-sort entry point at all. `seq.sortStable`/`seq.sortStableBy` are therefore `library`, lowered to a small
decorate/sort/undecorate helper (`stable_sort_by_comparator`/`stable_sort_by_key` in
`_support.rb`): each element is paired with its original index before sorting, the index breaks
any tie the comparator or key called equal, and the pairs are unwrapped afterward. `get-holidays`'s
stable ordering of same-day holidays (Tiradentes before Sexta-feira Santa on 2000's 21 April) is
exactly what exercises this, and it is covered by conformance.

## Integer division and remainder: floored, like Python

Ruby's `/` and `%` on `Integer` floor, precisely like Python's `//`/`%` and precisely unlike the
Core's truncating `int.div`/`int.mod`. The native `/`/`%` lowering is selected only when both
operands are proven non-negative (where floored and truncated division agree); otherwise a small
`trunc_div`/`trunc_mod` helper in `_support.rb` corrects the sign, mirroring the structure of
Python's own two-candidate table for the same reason. Unlike Python's backend, which inlines the
correction formula at every call site to dodge CPython's per-call frame cost, this backend calls
the helper: Ruby method dispatch on a module singleton method is cheap enough that the inlining
trade Python made for measured reasons was not repeated here without its own measurement, and a
named helper is the more readable generated source of the two.

## Nested ternaries: flattened before printing, not left for the formatter

A checked accessor (`seq.at`, `str.charAtOpt`, …) lowers to a ternary, and Ruby's own conditional
expression (`test ? then : else`) is what represents it, exactly as Python represents the same
shape with `then if test else else`. When one of *that* ternary's own branches is itself another
checked accessor — `symbol == "*" ? "*" : padded[taken]` — the natural translation nests one
ternary inside another, which is exactly the shape `format-cnpj`'s pattern-matching code produces.

Standard Ruby's own `Style/NestedTernaryOperator` cop always wants this rewritten, and running its
autocorrection against this backend's naive nested-ternary output found a genuine bug in
`rubocop` 1.69.2 (the version `standard` 1.43.0 pins): its `Layout/EndAlignment` corrector entered
an infinite correction loop on one specific generated method (`group_thousands`,
`lib/format.rb`) and crashed `standardrb --fix` outright rather than converging. Rather than carry
a workaround for a third party's bug, the printer avoids ever emitting the shape that triggers it:
a ternary whose branch is itself a ternary has that inner one bound to its own local first
(`(nested_1 = *inner*; *outer test* ? *outer then* : nested_1)`), so what standardrb's cop and
corrector ever see is a chain of ordinary, unnested ternaries. Binding the branch *before* the
outer test runs, rather than only inside the branch that needs it, changes evaluation from lazy to
eager — sound only because every expression in the accepted subset is pure (`docs/semantics.md`
§7), and a checked accessor's own test is exactly what makes evaluating its "present" branch safe
unconditionally. Differential conformance (4256/4256, both idiom modes) and the fuzz generator
both exercise this path.

## Shape of the output

- **One flat namespace, not one module per source module the way Python's `from .x import y`
  is.** Every generated file reopens the same top-level `module Core`; a function defined in one
  file calls a sibling defined in another with a bare, unqualified name, which Ruby resolves
  through the implicit `self` receiver of a `def self.foo` singleton method — the same way Go's
  single flat `package core` needs no per-file import statements between its own files at all.
  This was the simplest sound choice available: names are already globally unique across the whole
  program before any backend sees them (`Lowerer.assignNames` runs once over the full function
  closure), so there was never a collision for a namespace to prevent, and Ruby has no per-file
  module system the way JavaScript or Python does to make one otherwise necessary.
  `require_relative` lines are still generated (computed from the same cross-module call graph
  every other target's imports come from) — they are what makes the callee's `def self.` visible
  before it is ever called, not what qualifies the call.
- Each file's own `require_relative` lines are computed exactly the way Python's `from .x import y`
  targets are (`computeImports`, shared, `backend/generate.ts`); what changes is only that Ruby's
  printer discards the *names* half of that computation (nothing to selectively import — the whole
  file loads) and keeps only the *path* half.
- Visibility: a function the source module never exported is `private_class_method`'d at the
  bottom of its file. No renaming is needed the way Python's leading-underscore convention needs
  it (`applyPrivacy`, target-specific, in the Python backend): `def self.foo` and
  `private_class_method :foo` name the exact same, unqualified `foo`, and Ruby's implicit-receiver
  rule (`self.a` calling `b` bare, when `b` is `private_class_method`'d, still works — only an
  *explicit* receiver like `Core.b` from outside is blocked) already gives an in-module bare call
  free rein, which is exactly the access pattern every generated call already uses.
- Records are `Data.define(:field, ...)` — introduced in Ruby 3.2, the reason this backend's
  baseline is not 3.0 or 3.1 — immutable value objects with structural `==` generated for free,
  which is what lets the differential driver compare a record answer with `JSON.generate` after a
  single, generic `#to_h`-based `encode` pass, the same shape Python's `dataclasses.asdict` plays
  for its own driver.
- Module-level hoisted constants (a lifted table, a compiled `Regexp`) are printed **upper cased**.
  This is not a style choice the way Python's upper-casing is (Python's constant convention is
  just convention; a lower-case Python module global is still a perfectly readable global): a
  *lower-case* assignment at a Ruby module body's top level is a **local variable**, invisible from
  inside a `def self.foo` defined later in the very same `module` block — calling it from inside a
  method raises `NameError`, not merely a style complaint. Every reference to a hoisted name is
  upper-cased by the same text pass that upper-cases the declaration, driven off the module's own
  list of hoisted constants (never a guessed pattern), mirroring the mechanism Python's own
  constant pass already uses for its own (optional, not required) reason.
- Domain errors are `class FooError < DomainError` inside `module Core`, `DomainError <
  StandardError`, `raise FooError.new(...)`. `StandardError`'s own `initialize(msg = nil)` is
  already what a one-argument error needs; no custom constructor is generated.
- **This target ships a default `Capabilities`** (`Net::HTTP`, `Time.now`, `Random.rand`), so a
  utility whose effects reach `Http`, `Clock` or `Random` gets the same public-wrapper-plus-seam
  split TypeScript and Python get (`docs/decisions/0011-*.md`) — unlike Go and Rust, which ship no
  concrete default and leave the capability-taking form as the only entry point.
- `task.race` is one `Thread` per task and a `Queue` collecting the first present answer;
  cancellation is best effort (a losing thread may run to completion, its answer dropped), matching
  `docs/semantics.md` §4.2 the same way Python's `ThreadPoolExecutor` does.
- Randomness: `Random.rand(0...4_294_967_296)` for `random.nextU32`, drawing from Ruby's own
  default PRNG (Mersenne Twister) rather than `SecureRandom` — not cryptographically secure,
  deliberately, exactly the same call Python's own default capability makes and for the same
  documented reason (the utilities that draw are generating example documents, which is what the
  published package itself does). The differential driver never reaches this: it injects a
  from-scratch PCG32 matching the interpreter's own reference generator bit for bit, the same as
  every other target's driver does.

## String literals: a target-owned escaper, not the shared `asciiString`

`tast.ts`'s shared `asciiString` (used directly by the Python and Go backends) is not reused here.
It spells an astral scalar `\Uxxxxxxxx` — valid JavaScript and Python source, but not valid Ruby,
which only ever reads a variable-length `\u{...}`. A Ruby double-quoted string also treats a bare
`#` as the start of interpolation (`#{...}`, `#@ivar`, `#$global`), which none of JavaScript's,
Python's or Go's literal syntax does, so `#` needs escaping here that none of those three languages
would want applied to their own string literals. `rubyString` in this backend's `index.ts` is the
target-owned equivalent, following the same shape (`raw()` fragments, ASCII-only output, no BOM)
without touching the shared helper the other backends still rely on being exactly what it is.

## Formatter and linter are one tool

Standard Ruby (`standardrb`) is not two commands the way `ruff format`/`ruff check` are: one
invocation both formats and lints, and reports a formatting deviation as an ordinary offense
exactly the way it reports a real style or correctness violation. `format.ts` therefore pins
`standardrb --fix` as the formatter (run during `build`); `verify.ts`'s "linter" step and its
"formatter check" are, honestly, the *same* command run without `--fix` — a file that is not
already in the exact shape `--fix` would leave it in is reported as an offense either way, which is
what makes a single invocation cover both. There is no rubocop config file: Standard Ruby is
deliberately non-configurable (that is its entire premise), so there is nothing here to pin beyond
the gem's own version, already recorded in `toolchain.lock.json`.

## What is deliberately left out of the capability table

`dec.divRound`, `dec.rescale` and `dec.fromFloat` — division, rescaling and float conversion under
an explicit rounding mode — have no candidate here, the same gap every one of the other four
targets already has (none of TypeScript's, Python's, Go's or Rust's tables implements them
either). None of the nine current utilities calls them (`formatCurrency` takes its `Decimal<2>`
argument pre-scaled; the rounding those three ops would need lives in the DX, not the core), so
this is an existing, project-wide gap this backend inherits rather than one it introduces — not a
Ruby limitation. Ruby's own `Rational`/`BigDecimal` could implement all three soundly if a caller
ever needed them; that is future work for whichever target adds them first, not a decision forced
by this language.

Every other intrinsic the reference documents (`docs/intrinsics.md`) has a sound Ruby lowering, and
this table implements that full remaining surface — not only the ~48 operations the nine current
utilities actually reach — the same breadth Python's table has.
