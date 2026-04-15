# Default policy bundle for research-style agents.
#
# Bundles the egress and budget shape we want for any gen whose job is
# "use web search to answer a question." A gen pulls this in by symbol:
#
#   security :research_defaults
#   budget   :research_defaults

# Hosts allowed for web search backends. Tavily for general search,
# Exa for neural search. block_private + block_metadata default true.
network \
  allowlist: %w[api.tavily.com api.exa.ai]

# Conservative caps. Research agents tend to wander; tight per-tool
# caps keep the loop honest. Per-run cap of 20 catches anything that
# slips past the per-tool gates.
budget \
  per_tool: { web_search: { max_calls: 5 } },
  per_run:  { max_calls: 20 }
