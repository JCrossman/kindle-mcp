#!/usr/bin/env bash
# Apply this repository's security settings with the GitHub CLI. Run it on your own machine as the
# repository owner, once per repository:
#
#     gh auth login                                  # device-code flow in the browser
#     scripts/repo-settings.sh OWNER/REPO            # settings only (repo may stay private)
#     scripts/repo-settings.sh OWNER/REPO --public   # same, then make it public and enable the
#                                                    # scanners that need a public repository
#
# Re-running is safe: every call sets an absolute state. The one exception is the ruleset, which
# is created only if no ruleset named "main" exists yet.
set -euo pipefail

REPO="${1:?usage: $0 OWNER/REPO [--public]}"
PUBLIC="${2:-}"

api() { gh api --method "$1" "repos/$REPO$2" "${@:3}"; }
say() { printf '\n== %s\n' "$*"; }

say "General: auto-delete merged branches, no wiki or projects"
api PATCH "" --input - >/dev/null <<'JSON'
{ "delete_branch_on_merge": true, "has_wiki": false, "has_projects": false, "allow_auto_merge": true }
JSON

say "Actions: only GitHub-authored and verified actions, read-only token, no PR approvals by Actions"
api PUT /actions/permissions --input - >/dev/null <<'JSON'
{ "enabled": true, "allowed_actions": "selected" }
JSON
api PUT /actions/permissions/selected-actions --input - >/dev/null <<'JSON'
{ "github_owned_allowed": true, "verified_allowed": true, "patterns_allowed": [] }
JSON
api PUT /actions/permissions/workflow --input - >/dev/null <<'JSON'
{ "default_workflow_permissions": "read", "can_approve_pull_request_reviews": false }
JSON
api PUT /actions/permissions/fork-pr-contributor-approval --input - >/dev/null <<'JSON' || echo "   (fork PR approval policy endpoint unavailable; set it under Settings > Actions if needed)"
{ "approval_policy": "all_external_contributors" }
JSON

say "Dependabot alerts, security updates, private vulnerability reporting"
api PUT /vulnerability-alerts >/dev/null
api PUT /automated-security-fixes >/dev/null
api PUT /private-vulnerability-reporting >/dev/null

say "Ruleset for the default branch"
if gh api "repos/$REPO/rulesets" --jq '.[].name' | grep -qx main; then
  echo "   ruleset 'main' already exists, leaving it as is"
else
  # No code-owner review requirement: on a single-maintainer repository it would block the
  # maintainer from merging their own pull requests. Pull requests are still required, review
  # threads must be resolved, CI must pass on an up-to-date branch, and nobody can force-push
  # or delete the branch. No bypass list.
  api POST /rulesets --input - >/dev/null <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["merge", "squash"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [ { "context": "test (22)" }, { "context": "test (24)" } ] } }
  ]
}
JSON
fi

if [ "$PUBLIC" = "--public" ]; then
  say "Visibility: public"
  api PATCH "" --input - >/dev/null <<'JSON'
{ "visibility": "public" }
JSON
  say "Secret scanning: push protection, non-provider patterns, validity checks (needs a public repository)"
  api PATCH "" --input - >/dev/null <<'JSON'
{ "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" },
    "secret_scanning_non_provider_patterns": { "status": "enabled" },
    "secret_scanning_validity_checks": { "status": "enabled" } } }
JSON
fi

say "Result"
gh api "repos/$REPO" --jq '{visibility, delete_branch_on_merge, has_wiki, has_projects, security_and_analysis}'
gh api "repos/$REPO/rulesets" --jq '.[] | {name, enforcement}'
gh api "repos/$REPO/actions/permissions/workflow"
echo
echo "Publishing uses npm trusted publishing: on npmjs.com, the package's Trusted Publisher setting names"
echo "this repository and publish.yml. No token is needed. Release with:"
echo "  gh workflow run publish.yml --repo $REPO -f version=\$(node -p \"require('./package.json').version\")"
