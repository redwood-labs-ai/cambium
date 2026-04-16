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

default   "omlx:Qwen3.5-27B-4bit"
fast      "omlx:gemma-4-31b-it-8bit"
embedding "omlx:bge-small-en"
