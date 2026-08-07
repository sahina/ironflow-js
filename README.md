# Ironflow — JS SDK (Public Source Mirror)

This repository hosts the **public source** of the [Ironflow](https://ironflow.run) JavaScript/TypeScript SDK packages published to npm.

## Packages

| npm | Path |
|---|---|
| [`@ironflow/core`](https://www.npmjs.com/package/@ironflow/core) | [`packages/core/`](packages/core) |
| [`@ironflow/browser`](https://www.npmjs.com/package/@ironflow/browser) | [`packages/browser/`](packages/browser) |
| [`@ironflow/node`](https://www.npmjs.com/package/@ironflow/node) | [`packages/node/`](packages/node) |
| [`@ironflow/langgraph`](https://www.npmjs.com/package/@ironflow/langgraph) | [`packages/langgraph/`](packages/langgraph) |

All four packages version in lockstep.

## What lives here

- `.ts` source for the SDK packages above
- Generated protocol code (`packages/core/src/gen/`) vendored from the engine repo
- `pnpm-workspace.yaml`, root `package.json`, and per-package configs needed to build locally
- `LICENSE` and security policy

## Where the engine source lives

The Ironflow engine is **closed source** and lives at `sahina/ironflow` (private). This mirror exists so that:

- `npm` "Repository" links resolve to public source
- README source links (`/blob/main/...`) resolve to public source
- npm sigstore provenance attests to a publicly verifiable Git SHA

## Building locally

```bash
pnpm install
pnpm -r build
```

Requires Node.js 22+ and pnpm.

## Read-only mirror

This repo is **read-only**. Pull requests will be closed without review. Source changes land in the engine repo and are synced here at each release.

## Bug reports

All Ironflow bug reports — SDK, engine, CLI, dashboard, desktop — go to one tracker:

- Bugs and feature requests → [sahina/ironflow-issues](https://github.com/sahina/ironflow-issues/issues/new/choose). Pick **JS SDK** as the component.
- Security issues → [private advisory](https://github.com/sahina/ironflow-issues/security/advisories/new) or see [SECURITY.md](SECURITY.md) — do **not** open a public issue
- Commercial-licensing enquiries → the support address in [LICENSE](LICENSE)

## Verifying release integrity

Every published tarball (v0.22.5+) carries a [sigstore keyless](https://docs.sigstore.dev/quickstart/quickstart-cosign/) provenance attestation. Verify with:

```bash
npm audit signatures
```

Or per-package:

```bash
npm view @ironflow/core --json | jq '.dist.attestations'
```

The attestation binds the published tarball to a commit on this mirror repo plus the workflow that built it:

```
identity: https://github.com/sahina/ironflow-js/.github/workflows/publish.yml@refs/tags/v0.22.5
issuer:   https://token.actions.githubusercontent.com
```

## License

See [LICENSE](LICENSE) — SPDX: `LicenseRef-Ironflow-EULA`.
