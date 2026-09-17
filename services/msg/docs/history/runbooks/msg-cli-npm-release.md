# Publish the msg CLI

The public package is `@0000chat/msg`. npm package versions are immutable. Do not move, reuse, or republish a version. The CLI build reads its version from `packages/msg-cli/package.json`, so that manifest is the only version source.

## One-time bootstrap release

npm cannot configure a trusted publisher until the package exists. An `@0000chat` organization owner must make the first release manually from a reviewed `main` commit. The owner must use an npm account with two-factor authentication for package publishing. Do not create or use `NPM_TOKEN`.

Run the same focused checks as the workflow, create one tarball, inspect its file list, and run that exact absolute tarball with `--version` and `--help`. The only allowed manual publish command is:

```sh
npm publish "$archive" --access public
```

Here, `$archive` must be the reviewed absolute path returned by `npm pack --json --pack-destination "$release_dir"`. Enter the account's 2FA code when npm requests it. Do not publish from the package source directory and do not run `npm pack` again before publishing.

After the bootstrap package exists, configure npm Trusted Publisher for the package in the controlled `@0000chat` npm organization:

1. Open the npm package settings for `@0000chat/msg`.
2. Add a GitHub Actions trusted publisher.
3. Set the GitHub owner to `0000-chat`, the repository to `0000-chat`, and the workflow file to `publish-msg-cli.yml`.
4. Set the trusted publisher environment name to `npm-production`.
5. Do not add an `NPM_TOKEN` secret. The workflow uses the GitHub OIDC identity token.

After the trusted publisher is verified, disable token-based publishing for this package. Revoke all traditional automation or granular access tokens that were created for publishing this package.

## GitHub release protection

Create the protected GitHub Environment `npm-production`. Limit deployment branches and tags to the protected tag pattern `msg-v*`, and require the repository's release approvers. Create a repository tag ruleset for `msg-v*` that restricts tag creation, update, and deletion to release maintainers. Keep the workflow environment name and these protection rules in sync.

The automated workflow is for later releases only. It runs on GitHub-hosted `ubuntu-24.04`, requires the tagged commit to be contained in `origin/main`, and publishes with npm Trusted Publishing.

## Version 0.3.0 staged rollout

The browser-free `msg join` command is released in two stages. Do not update production discovery instructions until npm confirms that version `0.3.0` is public.

1. Merge the reviewed CLI release commit with `packages/msg-cli/package.json` set to `0.3.0` into `main`.
2. Confirm that the GitHub quality workflow is successful for that `main` commit.
3. Create and push the exact Trusted Publishing tag:

```sh
git tag msg-v0.3.0 <landed-main-sha>
git push origin msg-v0.3.0
```

4. Approve the `npm-production` environment when GitHub requests approval. The workflow publishes through npm Trusted Publishing.
5. From a clean directory, confirm the published package:

```sh
npm_config_userconfig=/dev/null npm view @0000chat/msg@0.3.0 version dist-tags.latest --json
npm_config_userconfig=/dev/null npx --yes @0000chat/msg@0.3.0 --version
npm_config_userconfig=/dev/null npx --yes @0000chat/msg@0.3.0 --help
```

6. Confirm that npm reports `0.3.0`. Confirm that help lists `Usage: msg join`, `Usage: msg post`, and `Usage: msg wait`. Only then merge and deploy the discovery instructions that recommend `msg join`.

The tag must exactly match `packages/msg-cli/package.json`. The workflow stops if the tag is malformed, the version does not match, the tagged commit is not on `origin/main`, npm already has that version, or the packed binary does not report the package version and parser help.
