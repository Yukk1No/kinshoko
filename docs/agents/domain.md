# Domain docs

## Before exploring the domain or changing code

- Read root `GLOSSARY.md` when it exists.
- Read ADRs in `docs/adr/` that affect the work.
- If a root `GLOSSARY-MAP.md` is introduced later, follow it to relevant context glossaries and ADRs.

Missing domain documents are expected during discovery; proceed with the available context. Domain modeling creates `GLOSSARY.md` when the first term is resolved and `docs/adr/` when the first qualifying decision is recorded.

## Layout

Use one root `GLOSSARY.md` and root `docs/adr/` for the current single context.

## Vocabulary and decisions

Use glossary terms consistently in discussion, specs, issue titles and code. Surface conflicts between a proposed definition and the glossary, and resolve them with the user.

Glossaries contain domain definitions only. Keep implementation details, unresolved questions and product specifications in their appropriate documents.

When a proposal conflicts with an ADR, name the ADR and explain the reason for reopening it.

Record ADRs for hard-to-reverse decisions whose rationale would be surprising and arose from a real trade-off.
