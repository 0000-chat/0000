# Import a service repository into the 0000 monorepo

Use this how-to when a service moves from an independent repository into
`services/<service>` in the public 0000 monorepo. It covers Git history,
local work, GitHub issues, and Codex sessions.

The [Communicator import report](../../services/communicator/docs/migration/2026-09-15-monorepo-import.md)
contains the run-specific SHAs, counts, mappings, backup manifest, and
validation output. Keep those facts in the report so this page stays reusable.

Run local work on a `codex/` migration branch. Follow the user's existing
authorization for the import and issue transfer. Keep the source checkout
and every worktree until cutover has passed. Publish commits, archive or
delete source repositories, change visibility, or cut over production only
when those actions are within the authorized scope.

## 1. Set paths and storage

Use absolute paths and resolve symlinks before copying a checkout or worktree.
Use a task directory outside `/tmp` when that filesystem is constrained.

~~~sh
source_repo=/home/ubuntu/0000-full/repos/0000-communicator
destination_repo=/home/ubuntu/0000-full/0000
service_name=communicator
service_dir="$destination_repo/services/$service_name"
package_name="@0000/$service_name"
source_github_repo=0000-chat/0000-communicator
destination_github_repo=0000-chat/0000
migration_stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_root="/home/ubuntu/0000-full/migration-backups/$service_name-$migration_stamp"
task_tmp="/home/ubuntu/0000-full/migration-tmp/$service_name-$migration_stamp"
mkdir -p "$backup_root" "$task_tmp"
chmod 700 "$backup_root" "$task_tmp"
df -h /tmp /home/ubuntu/0000-full
export TMPDIR="$task_tmp"
~~~

Do not reuse a backup directory. Preserve the original source checkout.

## 2. Read instructions and establish scope

Read the controller rules, architecture records, both repository READMEs, and
all applicable source instructions before selecting a source tip:

~~~sh
sed -n '1,240p' /home/ubuntu/0000-full/AGENTS.md
sed -n '1,260p' /home/ubuntu/0000-full/docs/GRAND_VISION.md
sed -n '1,260p' /home/ubuntu/0000-full/docs/ARCHITECTURE_HANDOFF.md
sed -n '1,260p' /home/ubuntu/0000-full/workspace.json
find "$source_repo" -name AGENTS.md -print
sed -n '1,220p' "$source_repo/README.md"
sed -n '1,220p' "$destination_repo/README.md"
~~~

Check both repositories and their live remotes:

~~~sh
git -C "$source_repo" status --short --branch
git -C "$source_repo" remote -v
git -C "$destination_repo" status --short --branch
git -C "$destination_repo" remote -v
gh repo view "$source_github_repo" --json nameWithOwner,visibility,defaultBranchRef,url
gh repo view "$destination_github_repo" --json nameWithOwner,visibility,defaultBranchRef,url
~~~

Keep the destination root Bun and Turbo files and the service wrapper named
`@0000/<service>`. Keep the service's pnpm and Rust tooling in its
subtree. Preserve shared Platform identity and service authorization rules.
Keep credentials, runtime databases, generated dependencies, private
operations, and excluded cloud code out of tracked public files while
preserving required local state in the backup.

## 3. Inventory every source state

Capture change classes separately. A staged patch differs from an unstaged
patch; untracked nonignored files differ from ignored files:

~~~sh
git -C "$source_repo" rev-parse HEAD > "$backup_root/source-head.txt"
git -C "$source_repo" status --short --ignored > "$backup_root/source-status.txt"
git -C "$source_repo" diff --no-ext-diff --binary > "$backup_root/source-unstaged.patch"
git -C "$source_repo" diff --cached --no-ext-diff --binary > "$backup_root/source-staged.patch"
git -C "$source_repo" ls-files --others --exclude-standard > "$backup_root/source-untracked.txt"
git -C "$source_repo" ls-files --others --ignored --exclude-standard > "$backup_root/source-ignored.txt"
git -C "$source_repo" for-each-ref --format='%(refname) %(objectname) %(symref)' > "$backup_root/source-refs.txt"
git -C "$source_repo" worktree list --porcelain > "$backup_root/source-worktrees.txt"
git -C "$source_repo" stash list --date=iso > "$backup_root/source-stashes.txt"
git -C "$source_repo" fsck --full --no-progress > "$backup_root/source-fsck.txt"
~~~

For each ignored path, record type, size, owner, and regeneration status.
Include dependencies, generated output, runtime files, secret material, and
local skill links. Preserve every branch tip, remote ref, archived ref, stash,
and divergent alternative before choosing a base.

Inspect every registered worktree, including missing registrations. Save its
resolved path, status, staged and unstaged patches, untracked files, and
ignored paths:

~~~sh
git -C "$source_repo" worktree list --porcelain |
  awk '$1 == "worktree" { print substr($0, 10) }' > "$task_tmp/worktree-paths.txt"
while IFS= read -r worktree_path; do
  key=$(printf '%s' "$worktree_path" | sha256sum | cut -d ' ' -f1)
  out="$backup_root/worktrees/$key"
  mkdir -p "$out"
  printf '%s\n' "$worktree_path" > "$out/path.txt"
  if git -C "$worktree_path" status --short --ignored > "$out/status.txt" 2>&1; then
    realpath "$worktree_path" > "$out/realpath.txt"
    git -C "$worktree_path" diff --binary > "$out/unstaged.patch"
    git -C "$worktree_path" diff --cached --binary > "$out/staged.patch"
    git -C "$worktree_path" ls-files --others --exclude-standard -z > "$out/untracked.nul"
    git -C "$worktree_path" ls-files --others --ignored --exclude-standard > "$out/ignored.txt"
  else
    printf '%s\n' 'missing or invalid worktree registration' >> "$out/status.txt"
  fi
done < "$task_tmp/worktree-paths.txt"
~~~

Record all releases, open and closed issues, open and closed pull requests,
remote refs, and archived refs. Put the resulting inventory and any dirty
worktree reconciliation in the run report.

## 4. Back up before importing

Create and verify complete source and destination bundles. Archive the
destination scaffold and source tree. Include worktree patches, untracked
files, required ignored local state, and database backups. List every
exclusion by path and size:

~~~sh
git -C "$source_repo" bundle create "$backup_root/source-all.bundle" --all
git -C "$destination_repo" bundle create "$backup_root/destination-all.bundle" --all
git bundle verify "$backup_root/source-all.bundle" > "$backup_root/source-bundle-verify.txt"
git bundle verify "$backup_root/destination-all.bundle" > "$backup_root/destination-bundle-verify.txt"
git -C "$destination_repo" archive --format=tar --output="$backup_root/destination-scaffold.tar" HEAD
git -C "$source_repo" archive --format=tar --output="$backup_root/source-tracked.tar" HEAD
find "$backup_root" -type f ! -name SHA256SUMS -print0 | sort -z |
  xargs -0 sha256sum > "$backup_root/SHA256SUMS"
sha256sum --check "$backup_root/SHA256SUMS"
~~~

Keep the source unchanged until destination and remote checks complete. Treat
a full-state copy as pending until its manifest and checksums verify. Keep
bundles and the original checkout for recovery.

## 5. Capture and transfer GitHub issues

Capture all source issues, comments, labels, milestones, releases, pull
requests, and parent, sub-issue, and dependency relationships:

~~~sh
mkdir -p "$backup_root/issues"
gh issue list --repo "$source_github_repo" --state all --limit 1000 \
  --json number,title,state,url,labels,assignees,author,milestone,createdAt,updatedAt,closedAt \
  > "$backup_root/issues/source-issues-index.json"
gh label list --repo "$source_github_repo" --limit 1000 > "$backup_root/issues/source-labels.txt"
gh release list --repo "$source_github_repo" --limit 1000 > "$backup_root/issues/source-releases.txt"
gh pr list --repo "$source_github_repo" --state all --limit 1000 \
  --json number,title,state,url,headRefName,baseRefName,author,createdAt,updatedAt \
  > "$backup_root/issues/source-pull-requests.json"
~~~

Use GitHub's native transfer for open and closed issues. Apply
`service:<service>` in the destination. Native transfer can change issue
numbers and node IDs. Snapshot old number, URL, and IDs, then record actual
destination values. Verify title, body, state, state reason, authors,
assignees, milestones, labels, timestamps, comments, redirects, and
relationships. Repair dependency edges with destination database IDs.

After each mutation, revalidate through a fresh API request with a unique
cache-busting query parameter. An old URL that appears unchanged can be stale.
Inspect its redirect and the fresh destination endpoint before deciding that a
transfer failed. Do not replay a successful transfer or delete an apparent
duplicate.

~~~sh
issue_number=1
destination_issue_number=1
gh issue view "$issue_number" --repo "$source_github_repo" --comments \
  --json number,title,body,state,stateReason,url,author,assignees,labels,milestone,comments,createdAt,updatedAt,closedAt
gh api "repos/$destination_github_repo/issues/$destination_issue_number?migration_check=$migration_stamp"
gh api "repos/$destination_github_repo/issues/$destination_issue_number/dependencies/blocked_by"
gh api "repos/$destination_github_repo/issues/$destination_issue_number/dependencies/blocking"
~~~

Write an old-to-new mapping and repair native parent, sub-issue, and
dependency edges from it. Do not rewrite issue numbers in source code or old
links from a guessed mapping.

Pull requests have a separate lifecycle. Native issue transfer does not move
pull requests. Preserve each old URL and capture its review, comments,
commits, refs, and diff. For the Communicator run, PR 39 remains at
`https://github.com/0000-chat/0000-communicator/pull/39`; its code is included
through the selected source tip:

~~~sh
pr_number=39
gh pr view "$pr_number" --repo "$source_github_repo" --comments \
  --json number,title,state,url,headRefName,baseRefName,commits,comments
gh pr diff "$pr_number" --repo "$source_github_repo"
~~~

## 6. Preserve Codex sessions

Codex sessions live outside the source checkout. Use the application's session
discovery to identify its older roots and produce a manifest of session
metadata, modes, and live files. Do not scan unrelated workspace databases.
Inspect each discovered SQLite database read-only and use SQLite's backup API:

~~~sh
codex_root=/home/ubuntu/.codex
mkdir -p "$backup_root/codex"
find "$codex_root" -type f -print > "$backup_root/codex/session-files.txt"
find "$codex_root" -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) \
  -print > "$backup_root/codex/database-paths.txt"
codex_db="$codex_root/state_5.sqlite" # use the verified active DB from discovery
test -r "$codex_db"
sqlite3 -readonly "$codex_db" '.tables'
sqlite3 -readonly "$codex_db" ".backup '$backup_root/codex/state.sqlite'"
sqlite3 -readonly "$backup_root/codex/state.sqlite" 'pragma integrity_check;'
~~~

Repeat the manifest and backup only if application discovery identifies
additional configured Codex roots. Use supported session export or a
stopped-process copy for session files. Record active logs or rollouts left in
place; do not raw-rewrite an active database, WAL, or rollout. Preserve
manifests and hashes. Keep project relinking unverified until the application
proves it. The source `.codex`
directory may be empty and does not replace external session stores.

Resume a session with the relocated service working directory:

~~~sh
session_id=SESSION_ID
codex resume "$session_id" -C "$service_dir"
~~~

## 7. Select a base and import the prefix

Record the source checkout tip, source remote default branch, selected branch
tip, destination base, ancestry, and excluded tips. Confirm that the selected
tip contains the desired remote base and intended pull-request code. Preserve
divergent alternatives in namespaced refs; do not merge them implicitly.

Fetch every source ref into a destination-only namespace. Use that namespace
after the fetch:

~~~sh
SELECTED_BRANCH=codex/whatsapp-pilot-deployment
migration_namespace="refs/migration/$service_name"
test -z "$(git -C "$destination_repo" status --porcelain)"
git -C "$destination_repo" fetch origin main
git -C "$destination_repo" switch --create "codex/import-$service_name" origin/main
git -C "$destination_repo" fetch "$backup_root/source-all.bundle" \
  "+refs/*:$migration_namespace/*"
source_ref="$migration_namespace/heads/$SELECTED_BRANCH"
source_tip=$(git -C "$destination_repo" rev-parse "$source_ref")
destination_base=$(git -C "$destination_repo" rev-parse origin/main)
git -C "$destination_repo" archive --format=tar \
  --output="$backup_root/selected-source.tar" "$source_tip"
~~~

Create one commit with two parents: the destination base and source tip.
Back up the existing service scaffold, merge with the ours strategy without
committing, overlay the source archive below the service prefix, then adapt
and stage the wrapper, dirty-worktree changes, and exclusions before committing:

~~~sh
git -C "$destination_repo" archive --format=tar \
  --output="$backup_root/service-scaffold.tar" "HEAD:services/$service_name"
git -C "$destination_repo" merge -s ours --no-commit --allow-unrelated-histories "$source_tip"
mkdir -p "$service_dir"
git -C "$destination_repo" archive "$source_tip" | tar -x -C "$service_dir"
# Reconcile the backed-up scaffold deliberately, including the monorepo wrapper.
# Apply canonical metadata and exclusions, then stage the resulting service.
git -C "$destination_repo" add --all -- "services/$service_name"
git -C "$destination_repo" commit -m "Import $service_name service repository"
~~~

The scaffold overlay must be deliberate and reviewable. Do not make an empty
merge followed by a separate snapshot-only commit. The import commit itself
must carry both parents and the prefixed tree. Preserve source commit objects
without rewriting them.

~~~sh
import_commit=$(git -C "$destination_repo" rev-parse HEAD)
git -C "$destination_repo" rev-list --parents -1 "$import_commit"
git -C "$destination_repo" merge-base --is-ancestor "$source_tip" "$import_commit"
git -C "$destination_repo" ls-tree -d "$import_commit" "services/$service_name"
git -C "$destination_repo" fsck --full --no-progress
~~~

## 8. Adapt tooling and agent routing

Keep the source pnpm workspace, `pnpm-lock.yaml`, Rust workspace, and
`Cargo.lock` inside the service. Do not merge the service lockfile into root
`bun.lock`. Expose original application validation as `check:application`;
let root `check` validate monorepo structure and the service wrapper. If a
check derives product metadata from the repository basename, use the canonical
service name and record the baseline failure separately.

Route scope by directory:

- Root `AGENTS.md` contains workspace rules.
- `services/<service>/AGENTS.md` contains service-only rules.
- `git rev-parse --show-toplevel` from the service returns the monorepo.
- Destination GitHub commands use `--repo 0000-chat/0000` and
  `service:<service>`.
- Source GitHub commands use the old `--repo` until retirement.

Recalculate ignored skill-link targets at the new depth. For this migration,
source links used `../../../../skills/ecosystem/<name>` and destination links
under `services/<service>/.agents/skills` use
`../../../../../skills/ecosystem/<name>`. Compute targets with `realpath`;
do not copy relative links blindly:

~~~sh
find "$service_dir/.agents/skills" -type l -print |
while IFS= read -r link; do
  readlink "$link"
  realpath -e "$link"
done
git -C "$destination_repo" check-ignore -v "services/$service_name/.agents/skills/*"
~~~

## 9. Validate, recover, and close out

Run root and service checks separately, then record status and commit graph:

~~~sh
(
  cd "$destination_repo"
  bun install --frozen-lockfile
  bun run check
  bun run check:turbo
  bun run check:turbo:dry
  (cd "services/$service_name" && bun run check:application)
  git diff --check
) > "$backup_root/destination-checks.txt" 2>&1
git -C "$destination_repo" status --short --branch
git -C "$destination_repo" log --graph --oneline --decorate -12
~~~

Record every check as planned, in progress, verified, or blocked. Include the
wrapper, prefix, two-parent ancestry, namespaced alternatives, symlink targets,
source status, backup hashes, issue mapping and relationships, Codex copies,
and excluded-path review.

While the candidate is local, leave both bundles untouched. On failure, save
the output and make a recovery branch from the recorded destination base.
Restore a damaged destination from `destination-all.bundle`. Restore
worktree changes from staged and unstaged patches and the untracked archive.
Git rollback cannot reverse an issue transfer; use the mapping and snapshots
for issue recovery.

The migration is complete when the report shows:

- Every source ref, branch, stash, worktree, change class, ignored path,
  symlink, release, issue, and pull request is accounted for.
- Bundles, scaffold, local-state, worktree, issue, and Codex backups verify.
- The selected source tip is a merge parent with no source history rewrite.
- The prefix, wrapper, isolated pnpm and Rust tooling, and root Bun and Turbo
  checks pass.
- Private, secret, generated, runtime, and excluded material is absent from
  tracked destination files.
- Each issue has destination metadata, label, redirect, and relationship
  evidence. Each nontransferable PR retains its old URL.
- Codex records are recoverable, CLI resume has direct evidence, and project
  relinking is marked verified only after application evidence.
- Push, publication, source retirement, and production cutover each have a
  separate authorization and recorded result.
