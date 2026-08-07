# Contributing

**This repository is a read-only mirror.** External contributions are not accepted here.

The Ironflow JS SDK source is maintained in a private engine repository. This mirror is updated automatically by the release pipeline at each version tag.

## Reporting bugs

Everything goes to one tracker: [sahina/ironflow-issues](https://github.com/sahina/ironflow-issues/issues/new/choose).

- SDK bugs (in `@ironflow/{core,browser,node,langgraph}`) → file there and pick **JS SDK** as the component. Include version, repro steps, and minimal example.
- Engine, CLI, dashboard, and desktop bugs → same tracker, pick the matching component.
- Security issues → [private advisory](https://github.com/sahina/ironflow-issues/security/advisories/new) or see [SECURITY.md](SECURITY.md). Do **not** open a public issue.

## Pull requests

Pull requests opened against this repository will be closed without review. The only commits expected here come from the release pipeline mirroring source from the engine repo.

If you have a fix in mind, file an issue describing the bug and the proposed fix. The engine team will land the change in the private repo and it will appear here at the next release.

## License inquiries

For commercial licensing, see the contact in [LICENSE](LICENSE).
