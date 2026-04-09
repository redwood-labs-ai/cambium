# Data: Grounding Sources

**Doc ID:** gen-dsl/data/grounding-sources

## Purpose
Define named corpora and retrieval policies used by `grounded_in`.

## Minimal config (concept)
- source id
- connector (filesystem, postgres, s3)
- embedder model
- chunking rules
- access policy (which models/methods can use it)

## See also
- [[P - grounded_in]]
- [[S - Secrets & Data Boundaries]]
