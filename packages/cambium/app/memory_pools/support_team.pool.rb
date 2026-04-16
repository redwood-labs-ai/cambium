# RED-215: shared memory pool for the support-team gens (demo + test
# fixture for phase 2). Multiple gens can opt in via
# `memory :whatever, scope: :support_team, top_k: 5`; the pool is the
# authoritative source of truth for strategy, embed, and keyed_by, and
# the referencing gen can only set reader knobs like `top_k` or `size`.

strategy :semantic
embed    "omlx:bge-small-en"
keyed_by :team_id
