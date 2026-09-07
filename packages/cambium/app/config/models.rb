# RED-237: workspace-configurable model aliases.
#
# Each directive maps a symbolic name to a literal provider:model id.
# Gens reference these by symbol (`model :default`, `embed: :embedding`);
# the compiler resolves them to literals before emitting IR, so the
# runner always sees concrete ids. Adding a new alias? Just add a line.
# Swapping what `:default` resolves to? Change one string — every gen
# referencing `:default` picks it up on next compile.
#
# Names must match /\A[a-z][a-z0-9_]*\z/. Values must be literal provider-
# prefixed model ids (contain `:`).

default   "omlx:orinth-1.0-35b@q8_0"
fast      "omlx:nvidia/nemotron-3-nano-4b"
embedding "omlx:bge-small-en"
# Its max_tokens is a FLOOR: the ceiling in force is max(gen, this), so match
# the biggest gen in the workspace (RED-174: "match repair's ceiling to the largest
# gen's, not the smallest").
repair    "omlx:nvidia/nemotron-3-nano-4b", max_tokens: 16000, temperature: 0
