# Doxomachy

The internet's smallest AI has room for 1,000 approximate tokens. Add a belief, protect one, or watch weak beliefs disappear. A daily diary is written from whatever survives.

## Current launch mode
This repository contains the public, interactive launch build. State is local to the visitor's browser during validation. Each device gets five free moves. Paid checkout is deliberately disabled until seller identity, payout details, refund terms, moderation policy, and exact USD offer are approved.

## Run locally
```bash
python3 -m http.server 4173
# open http://localhost:4173
```

## Tests
```bash
npm test
```

## Product mechanics
- 1,000 approximate-token hard cap
- add and protect actions
- deterministic weakest-belief eviction
- diary generated from the strongest surviving beliefs
- copyable diary share text
- URL rejection and public-content acknowledgement

See [DESIGN.md](DESIGN.md) for the visual and writing system.
