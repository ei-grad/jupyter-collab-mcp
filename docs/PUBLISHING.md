# Publishing the `jupyter-collab-mcp` package

Public unscoped npm package, account **ei-grad**, MIT license.
The version is set in `package.json`.

## 1. Tarball contents

`files: ["dist", "skill", "README.md", "LICENSE"]`. Everything else—
`src/`, `test/`, `dev/`, `spike/`, `scripts/`, `.scratch/`, screenshots, `SPEC.md`,
and `docs/`—is excluded from the package. `dist` is built with
`tsc -p tsconfig.build.json` (only `src/**`, with `.d.ts` files and sourcemaps).

Check the file list before publishing:

```sh
pnpm build
npm pack --dry-run
```

Exactly five top-level entries are expected: `LICENSE`, `README.md`, `dist`,
`package.json`, and `skill`. `npm pack` does **not** run `prepublishOnly`, so
`pnpm build` must run first; otherwise an outdated `dist` will be included in
the tarball.

Install the generated tarball through npm and invoke its bin symlink. Calling
`dist/mcp/cli.js` directly does not verify package-manager entry-point behavior:

```sh
package_file=$(npm pack --silent)
install_dir=$(mktemp -d)
npm install --prefix "$install_dir" --ignore-scripts "./$package_file"
"$install_dir/node_modules/.bin/jupyter-collab-mcp" --version
```

## 2. npm token: only in `~/.npmrc`

The token is not stored in the repository and must not appear in `package.json`,
scripts, project variables, or commits. Do not create a local `.npmrc` in the
repository root.

Interactively:

```sh
npm login            # account ei-grad, 2FA
npm whoami           # must print ei-grad
```

Alternatively, put an automation token in the user-level file:

```sh
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" >> ~/.npmrc
chmod 600 ~/.npmrc
```

Verify that the token is absent from the repository:

```sh
git status --porcelain          # .npmrc must not appear
grep -rn '_authToken' . --exclude-dir=node_modules --exclude-dir=.git
```

## 3. Publishing procedure

1. Use the `main` branch, ensure the working tree is clean, and bump the version
   in `package.json`.
2. Verify that `bin` in `package.json` points to an existing file
   (`dist/mcp/cli.js`), that the source has the `#!/usr/bin/env node` shebang,
   and that it builds—`tsc` preserves the shebang (verified).
3. Run the full validation suite (also run by `prepublishOnly`):

   ```sh
   pnpm typecheck
   pnpm test:unit
   pnpm build
   ```

4. Publish:

   ```sh
   npm publish --access public
   ```

   `--access public` is required for the first release. `npm publish` runs
   `prepublishOnly`, so the checks from step 3 run again. If publishing with
   `pnpm publish`, add `--no-git-checks` only deliberately: by default, pnpm
   requires a clean working tree and the expected branch.

5. Tag and release:

   ```sh
   version=$(node -p "require('./package.json').version")
   git tag "v$version" && git push origin "v$version"
   ```

## 4. Verifying the published package

Use a clean cache to avoid picking up a local build:

```sh
version=$(node -p "require('./package.json').version")
NPM_CONFIG_CACHE="$(mktemp -d)" npx -y "jupyter-collab-mcp@$version" --help
```

Expected result: help text on stderr, an empty stdout, exit status 0, no
Jupyter request, and no token in either stream. stdout remains reserved for MCP
frames even for CLI help. Inspect the registry tarball contents:

```sh
npm view "jupyter-collab-mcp@$version" dist.tarball files
```

To verify it as an MCP server, add it to a client using the instructions in the
root `README.md` and call `server_list`: the server must respond without
starting Jupyter.

## 5. Installing the skill

The skill is included in the package (`skill/SKILL.md`) and is installed
separately—the MCP client does not load it automatically:

```sh
mkdir -p ~/.claude/skills/jupyter-collab
cp "$(npm root -g)/jupyter-collab-mcp/skill/SKILL.md" \
   ~/.claude/skills/jupyter-collab/SKILL.md
```

For Codex, either reference the file from `AGENTS.md` or copy it to
`~/.codex/prompts/`. See `skill/README.md` for details and verification.

## 6. After the release

- Run `npm deprecate jupyter-collab-mcp@<version> "..."` if a release is broken;
  `npm unpublish` is available only for a limited period and breaks clients.
- For the next version, bump `version`, update `docs/STATUS.md`, and update
  `skill/SKILL.md` if tool names or `request_id` semantics changed.
