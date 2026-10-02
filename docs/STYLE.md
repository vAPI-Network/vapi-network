# Writing rules for vAPI docs

Lead with the point. One idea per sentence, about twenty words, with a verb. Active voice.
Concrete: names, numbers, commands, mechanisms. Cut any sentence that could move to another
product unchanged. End on the last concrete point, no summary.

Formatting: no em dashes, no bold inside a sentence, no emoji, no header over a section shorter
than three sentences, tables for anything with three or more comparable rows, code blocks for
every command, request, response and error.

Samples: every request, response and error block is pasted from a real run against staging or
production, with the command that produced it directly above. Redact keys as `sk-…redacted`.
Never paste a recovery phrase or a passphrase.

Banned words: delve, foster, leverage, utilize, facilitate, empower, streamline, robust,
cutting-edge, paradigm, game changer, tapestry, realm, beacon, multifaceted, meticulous,
intricate, paramount, transformative, elevate, embark, supercharge, harness, ever-evolving,
seamless, seamlessly, effortless, unlock, revolutionary, next-generation.

Cut when they add nothing: just, simply, actually, truly, fundamentally, importantly, crucially,
inherently, it's worth noting, it's important to note, at its core, in order to, going forward,
in terms of, with regard to.

Patterns to avoid: "not X, but Y" contrasts; "Here's the thing" openers; colon reveals;
trailing "-ing" clauses that pretend to explain; "plays a vital role"; "experts agree";
"serves as"; rotating synonyms for one thing; self-answered questions; a metaphor as the last
line; "In conclusion".
