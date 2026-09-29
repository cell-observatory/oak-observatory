# Writing style — OAK documentation

Every prose surface of this project — the site in `docs/`, the READMEs, `DEMO.md`,
`ARCHITECTURE.md` — is written for a scientific audience in a formal documentation
register. The rules below are distilled from Gopen & Swan ("The Science of Scientific
Writing", *American Scientist* 78:550–558), Joseph Williams (*Style: Lessons in Clarity
and Grace*), the Nature and PLOS author guides, the JOSS review criteria, the ACM SIGPLAN
empirical-evaluation guidelines, and the Google and Microsoft documentation style guides.
Apply them to every new or edited passage. `CHANGELOG.md` records history and is exempt
from retroactive edits.

## Sentences

- **S1.** Keep the verb within about seven words of its grammatical subject; move long
  qualifiers to the start or end of the sentence.
- **S2.** Express each clause's action as a verb, not an abstract noun: "the CLI indexes
  each event", not "indexing is provided by the CLI".
- **S3.** Default to active voice with a named agent. Use passive only to keep an
  established topic in subject position or when the actor is genuinely irrelevant.
- **S4.** Describe behavior in the present tense. Use the imperative for instructions.
  Never promise future behavior.
- **S5.** Keep sentences at or under about 30 words — one main clause plus at most one
  subordinate clause.
- **S6.** Delete intensifiers (*very*, *really*, *simply*, *just*, *blazing*, *powerful*,
  *seamless*). If a modifier carries information, replace it with a measured number.

## Paragraphs

- **P1.** Open each sentence with the person, system, or component the sentence is about.
- **P2.** Put established information first and the point you want remembered at the end
  (the stress position).
- **P3.** Give the context or definition before the term or capability it explains.
- **P4.** Make one claim per paragraph.

## Documents

- **D1.** The first two sentences of a page state what the software does, who it is for,
  and how it relates to existing tools.
- **D2.** Headings use sentence case, are grammatically parallel among siblings, and end
  without punctuation. A heading may be a noun phrase; body copy may not be a fragment.
- **D3.** Address the reader as *you*. Refer to the software in the third person by name.
  Use *we* only for the Cell Observatory project itself.
- **D4.** Include at least one complete worked example: the exact command and the output
  it produces.
- **D5.** Document only released behavior. No roadmap language, no "coming soon".

## Diction

- **X1.** Define every domain term at its first appearance on a page, then use it
  unchanged. The canonical definitions live in `docs/what-is-oak.html`.
- **X2.** Use exactly one term per concept. Never vary a term for style: it reads as a
  distinction being drawn.
- **X3.** Spell out abbreviations at first use. Write *that is* and *for example*, not
  *i.e.* and *e.g.*
- **X4.** Write complete, punctuated sentences. No headline fragments, exclamation
  points, or superlatives.
- **X5.** Prefer the everyday word unless the technical word is more precise. Give every
  quantity a unit. Use American spelling.

## Claims

- **C1.** Replace performance adjectives with measured values and their conditions:
  "the Overview build fell from 29 s to 4.6 s", not "much faster".
- **C2.** Name the baseline, workload, and environment for every comparative claim.
- **C3.** State a capability's limits in the same passage as the capability.
- **C4.** Describe mechanism, not effect: name what the software reads, computes,
  stores, and emits.
- **C5.** Hedge claims that are not demonstrated; do not hedge measured results.

## Canonical terms

One term per concept, everywhere: **prompt** for one of your own turns (never request),
**task** for one of Claude's own to-dos (never subtask or chapter), **session** for one
Claude Code conversation, **Folders strip** (never module strip), **Spotlight** (never
heatmap), **Fleet** (never Multitasking), **Actions** (never Timeline, for the view),
**change map** (two words in prose; `changemap` is only the CLI verb), **four review
axes** (Diff · File · Folder · Prompt), **undo conflict** and **live conflict** (never
collision in prose). Per-edit review verbs are **Keep** and **Undo**; scoped review verbs
are **Accept**, **Reject**, and **Clear**; the resulting states are **accepted** and
**reverted**. The product is "OAK" at first mention on a page and "the
observatory" thereafter.
