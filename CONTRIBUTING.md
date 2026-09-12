# Contributing

Thank you for improving Adaptive Mastery Engine.

## Set up the project

Use Node.js 20 or later.

```bash
npm install
npm run check
npm run lint
npm test
npm run build
```

## Propose a change

Open an issue before changing formulas, defaults, or score semantics. Describe the behavior you want, the evidence for it, and the compatibility impact. A model change should include:

- focused tests for the new behavior;
- an explanation of any new constant;
- before-and-after results on representative interaction sequences;
- documentation updates when the public contract changes.

Keep pull requests narrow. Use clear commit messages and avoid unrelated formatting changes.

## Report a vulnerability

Follow [SECURITY.md](SECURITY.md). Do not open a public issue for a security vulnerability.
