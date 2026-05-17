# Security Policy

## Reporting vulnerabilities

Report suspected security vulnerabilities by emailing the address listed in the [LICENSE](LICENSE) file with subject line `[SECURITY] @ironflow/<package> — <one-line summary>`. Include:

- Affected package(s) and version (e.g., `@ironflow/core@0.22.4`).
- Reproduction steps or proof-of-concept.
- Impact assessment (auth bypass, RCE, info disclosure, etc.).
- Disclosure timeline expectations.

We acknowledge receipt within 3 business days and aim to provide a triage status within 7. Public disclosure happens after a fix ships, with a CVE issued if applicable.

**Please do not file public GitHub issues for security matters.**

## Verifying release integrity

Every published tarball (v0.22.5+) carries a sigstore keyless provenance attestation. Verify with `npm audit signatures` or per-package with `npm view <pkg> --json | jq '.dist.attestations'`.

Expected attestation identity:

```
identity: https://github.com/sahina/ironflow-js/.github/workflows/publish.yml@refs/tags/v<version>
issuer:   https://token.actions.githubusercontent.com
```

If `npm audit signatures` fails on an installed Ironflow SDK package, do not run code that depends on it. Email the security address with the exact output.

## Supported versions

The latest minor release receives security patches. Older minors are supported on a best-effort basis until the next major release.
