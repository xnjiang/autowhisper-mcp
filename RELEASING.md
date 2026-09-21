# Releasing

This package ships to **two** places and they are easy to let drift apart:

| Channel | What it feeds | How it gets updated |
| --- | --- | --- |
| npm | `npx autowhisper-mcp` — most installs | manually, from your laptop |
| Official MCP Registry | discovery in MCP clients / aggregators | automatically, by CI |

Between 0.1.0 and 0.1.4 only npm was updated. The registry stayed on 0.1.0 for
four releases, so anyone who found the server through registry-based discovery
installed four-versions-old code. `.github/workflows/sync-mcp-registry.yml` now
closes that gap on its own, but the npm half is still yours to do.

## Steps

1. **Bump the version in all four places.** They must agree or CI refuses to publish:
   - `package.json` → `version`
   - `server.json` → `version` (top level)
   - `server.json` → `packages[0].version`
   - `src/index.ts` → `new McpServer({ ..., version })`

   ```sh
   ./scripts/bump-version.sh 0.3.0
   ```

2. **Test and build.**
   ```sh
   npm test    # runs tsc, then node --test on dist/*.test.js
   ```

3. **Publish to npm.** `cd` into this directory first — `npm publish --prefix`
   does **not** work, it packages the current working directory instead. Check the
   tarball header says `autowhisper-mcp@<your version>` and that it contains only
   LICENSE, README.md, package.json and the `dist/*.js` runtime files — no
   `*.test.js`. (This used to say "total files: 5"; it became 6 when
   `poll-shape.ts` was split out of `index.ts`, so a fixed count just goes stale
   and gets ignored. Check the shape, not the number.)
   ```sh
   npm publish --access public
   ```

4. **Commit and push.** The push triggers the registry sync, which reads npm's
   `latest` and publishes a matching registry version.
   ```sh
   git commit -am "release: 0.3.0" && git push origin main
   ```

   ⚠️ **Order matters, and step 3 must really come first.** The sync job compares
   npm against the registry — it does not read this repo's version. Push before
   publishing (or publish while the job is already running) and it finds both
   channels still on the OLD version, reports `In sync at <old> — nothing to
   publish`, and exits green. Nothing is broken and nothing is wrong in the log;
   the new version simply is not in the registry, and stays out until the Monday
   cron. That happened on 0.4.0 (2026-07-28).

   If you pushed first, just run the job again once npm is updated:
   ```sh
   gh workflow run sync-mcp-registry.yml
   ```

5. **Confirm both channels agree.** CI does this itself and fails loudly if not,
   but to check by hand:
   ```sh
   npm view autowhisper-mcp version
   curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=autowhisper" \
     | jq -r '[.servers[]
               | select(._meta["io.modelcontextprotocol.registry/official"].isLatest == true)
               | .server.version][0]'
   ```

## How the sync job behaves

It is a **reconciliation** job, not a release hook: it compares npm's `latest`
against the registry's `isLatest` and closes any gap. That makes it correct no
matter how npm was published, and a no-op when the two already match. It runs on
push, weekly on a schedule (the backstop that would have caught all four missed
versions), and on demand.

- It never publishes a version npm does not already serve, so the registry cannot
  end up pointing at an uninstallable package.
- It refuses to run if `server.json` disagrees with npm, and the error tells you
  which field to fix.
- It reads the registry back afterwards instead of trusting the publish exit code.
- Auth is GitHub OIDC — no npm or registry secret is stored in this repo.

**Verify the plumbing any time** without publishing anything (downloads the
publisher, validates `server.json` against the live schema, performs the OIDC
login, then stops):

```sh
gh workflow run "Sync MCP Registry" -f dry_run=true
```

## Gotchas worth remembering

- **npm 2FA**: this account uses a passkey and npm has removed the TOTP option,
  so `--otp` has no code to give. Either use a recovery code, or publish through
  the browser auth flow the CLI offers.
- **`mcp-publisher` via Homebrew is unreliable** — its bottle download has failed
  twice. Grab the binary directly instead:
  ```sh
  gh release download v1.8.0 --repo modelcontextprotocol/registry --pattern "*darwin_arm64*"
  ```
- **The registry's `server.json` schema has migrated before** (to camelCase:
  `registryType`, `environmentVariables`, `isRequired`, `isSecret`). Don't guess
  it locally — `mcp-publisher validate` checks against the live schema. This is
  why CI deliberately installs the *latest* publisher rather than a pinned one.
