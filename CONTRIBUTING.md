# Contributing to prism-matching-engine

Thanks for taking the time to contribute! prism-matching-engine is a command-line tool by [Prism Protocol](https://github.com/krishyaa06) — Prism Matching Engine is the core of an exchange in plain JavaScript. Orders are validated against tick, lot, price band and available funds, then matched by price-time priority against sorted price levels with FIFO queues. Every fill settles immediately in a double-entry ledger (base, quote and fees, all integer 1e-8 units with BigInt notional), and resting orders hold exactly the funds they can still use. Stops trigger on the last trade and can cascade. A FIX 4.4 session layer handles Logon, sequence gaps, NewOrderSingle, Cancel and Replace with real BodyLength and CheckSum, and a TCP gateway exposes it. Every command is journaled, so replaying the journal on a fresh engine reproduces the same SHA-256 state hash.

## Getting started

```bash
git clone https://github.com/krishyaa06/prism-matching-engine.git
cd prism-matching-engine
npm start
```

## Before you open a pull request

Make sure everything passes locally:

```bash
npm test
```

## Guidelines

- **Zero dependencies.** Please don't add runtime dependencies — use Node.js built-ins (`node:fs`, `node:path`, `node:test`, …).
- **No build step, no frameworks.** Keep it plain HTML, CSS and JavaScript so it runs straight from GitHub Pages.
- **Everything stays in the browser.** Don't send user data to any server.
- Keep pull requests small and focused — one feature or fix per PR.
- Update the README when you change behaviour, flags or options.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add --json output
fix: handle empty input
docs: clarify install steps
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`. Add a short entry under **[Unreleased]** in [CHANGELOG.md](CHANGELOG.md) for user-facing changes.

## Reporting bugs & ideas

Open an [issue](https://github.com/krishyaa06/prism-matching-engine/issues) with:

- what you expected vs. what happened
- steps to reproduce
- your OS, browser or Node.js version

**Security issues:** please don't open a public issue — contact the maintainer privately via [GitHub](https://github.com/krishyaa06).

## License

By contributing, you agree that your contributions will be licensed under the project's [license](LICENSE).
