#!/usr/bin/env bash
# Set up the AI Factory operator to run AIJobs on other Rancher-managed clusters, step by step:
#
#   1. a service user the operator acts as on those clusters (you create it in Rancher)
#   2. its rights on each cluster: Cluster Member, and Project Owner of the project(s) runs go to
#   3. its API token (created while logged in as that user), checked to be that user's
#   4. the Secret the operator reads: Rancher's URL, the token and, when self-signed, Rancher's CA
#   5. a check, as that user through Rancher's cluster proxy, that each cluster can take a run
#   6. the chart values to enable it
#
# Run against the management cluster (where Rancher and the operator are), as a Rancher admin:
#
#   ./setup.sh --context <kube-context> --clusters gpu-east,gpu-west --project p-training
#   ./setup.sh --context <kube-context> --clusters gpu-east --project p-training --verify-only
#
# Every change is shown and confirmed first. The token is read without echo and never printed.
set -euo pipefail

CONTEXT="" CLUSTERS="" PROJECT="" USERNAME="aif-operator" NAMESPACE="aif-operator" SECRET="aif-remote-clusters" VERIFY_ONLY=0 YES=0
usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; cat <<'EOF'
Options:
  --context <ctx>       kube context of the management cluster (default: current)
  --clusters <names>    clusters runs may target, comma-separated: their names in Rancher, or their
                        IDs (c-xxxxx); a name more than one cluster has must be given as its ID
  --project <id>        project ID on those clusters whose namespaces runs use (e.g. p-training);
                        the same ID on every cluster, as Projects & Quotas > Place on clusters makes it
  --user <name>         the service user (default aif-operator)
  --namespace <ns>      the operator's namespace (default aif-operator)
  --secret <name>       the Secret's name (default aif-remote-clusters)
  --verify-only         change nothing; check the bindings, the Secret and the rights
  --yes                 do not ask before each change
EOF
}
while [ $# -gt 0 ]; do
  case "$1" in
    --context) CONTEXT="$2"; shift 2 ;;
    --clusters) CLUSTERS="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --user) USERNAME="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --secret) SECRET="$2"; shift 2 ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done
[ -n "$CLUSTERS" ] && [ -n "$PROJECT" ] || { usage >&2; exit 2; }
for t in kubectl curl python3 base64; do command -v "$t" >/dev/null || { echo "needs $t" >&2; exit 2; }; done

K=(kubectl --request-timeout=30s)
[ -n "$CONTEXT" ] && K+=(--context "$CONTEXT")
IFS=',' read -r -a WANTED <<< "$CLUSTERS"
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILED=1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { [ "$YES" = 1 ] && return 0; read -r -p "  $* [y/N] " a; [ "$a" = y ] || [ "$a" = Y ]; }
FAILED=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Rancher identifies a cluster by its ID (c-xxxxx), which never changes; people know it by its name,
# which can be changed and need not be unique. Names are resolved to IDs here, and both are shown.
"${K[@]}" get clusters.management.cattle.io -o jsonpath='{range .items[*]}{.metadata.name}|{.spec.displayName}{"\n"}{end}' > "$TMP/clusters"
CLUSTER_LIST=()
name_of() { awk -F'|' -v i="$1" '$1==i { print ($2 != "" ? $2 : $1) }' "$TMP/clusters"; }   # bash 3 (macOS): no maps
for w in "${WANTED[@]}"; do
  w=$(echo "$w" | xargs)
  if [ -n "$(name_of "$w")" ]; then CLUSTER_LIST+=("$w"); continue; fi
  ids=$(awk -F'|' -v n="$w" '$2==n {print $1}' "$TMP/clusters")
  case $(printf '%s' "$ids" | grep -c .) in
    1) CLUSTER_LIST+=("$ids") ;;
    0) echo "no cluster named or with ID \"$w\"; clusters: $(awk -F'|' '{printf "%s%s (%s)", sep, $2, $1; sep=", "}' "$TMP/clusters")" >&2; exit 1 ;;
    *) echo "more than one cluster is named \"$w\" ($(echo $ids | tr ' ' ',')): give its ID" >&2; exit 1 ;;
  esac
done
label() { n=$(name_of "$1"); [ "$n" = "$1" ] && echo "$1" || echo "$n ($1)"; }

step "1. The service user"
USER_ID=$("${K[@]}" get users.management.cattle.io -o jsonpath="{range .items[?(@.username==\"$USERNAME\")]}{.metadata.name}{end}")
if [ -z "$USER_ID" ]; then
  bad "no Rancher user \"$USERNAME\""
  cat <<EOF
    Create it in Rancher: Users & Authentication > Users > Create, username $USERNAME, a strong password,
    Global Permissions: Standard User. It needs no other global rights. Then run this again.
EOF
  exit 1
fi
ok "$USERNAME is $USER_ID"
for c in "${CLUSTER_LIST[@]}"; do
  "${K[@]}" get clusters.management.cattle.io "$c" >/dev/null 2>&1 || { bad "no cluster $c"; exit 1; }
  "${K[@]}" get projects.management.cattle.io -n "$c" "$PROJECT" >/dev/null 2>&1 || {
    bad "$(label "$c") has no project $PROJECT: place the project on it first (Projects & Quotas > Place on clusters)"; exit 1; }
done
ok "project $PROJECT is on $(for c in "${CLUSTER_LIST[@]}"; do printf '%s, ' "$(label "$c")"; done | sed 's/, $//')"

step "2. Its rights on each cluster"
for c in "${CLUSTER_LIST[@]}"; do
  crtb=$("${K[@]}" get clusterroletemplatebindings.management.cattle.io -n "$c" -o jsonpath="{range .items[?(@.userName==\"$USER_ID\")]}{.roleTemplateName} {end}")
  prtb=$("${K[@]}" get projectroletemplatebindings.management.cattle.io -n "$c-$PROJECT" -o jsonpath="{range .items[?(@.userName==\"$USER_ID\")]}{.roleTemplateName} {end}" 2>/dev/null || true)
  manifest="$TMP/bind-$c.yaml"
  : > "$manifest"
  if [[ " $crtb " == *" cluster-member "* || " $crtb " == *" cluster-owner "* ]]; then ok "$(label "$c"): cluster member"; else
    cat >> "$manifest" <<EOF
apiVersion: management.cattle.io/v3
kind: ClusterRoleTemplateBinding
metadata: {name: $USERNAME-cluster-member, namespace: $c}
clusterName: $c
roleTemplateName: cluster-member
userName: $USER_ID
userPrincipalName: local://$USER_ID
---
EOF
  fi
  if [[ " $prtb " == *" project-owner "* ]]; then ok "$(label "$c"): owner of $PROJECT"; else
    cat >> "$manifest" <<EOF
apiVersion: management.cattle.io/v3
kind: ProjectRoleTemplateBinding
metadata: {name: $USERNAME-project-owner, namespace: $c-$PROJECT}
projectName: $c:$PROJECT
roleTemplateName: project-owner
userName: $USER_ID
userPrincipalName: local://$USER_ID
EOF
  fi
  if [ -s "$manifest" ]; then
    if [ "$VERIFY_ONLY" = 1 ]; then bad "$(label "$c"): $USERNAME is missing $(grep -c '^kind:' "$manifest") binding(s) (run without --verify-only to add them)"
    else
      echo "  $(label "$c") needs:"; grep -E '^(kind|roleTemplateName):' "$manifest" | paste - - | sed 's/^/    /'
      if ask "Create them?"; then "${K[@]}" apply -f "$manifest" | sed 's/^/    /'; else bad "$(label "$c"): bindings not created"; fi
    fi
  fi
done

step "3. The API token"
TOKEN=""
existing=$("${K[@]}" -n "$NAMESPACE" get secret "$SECRET" -o jsonpath='{.data.token}' 2>/dev/null || true)
if [ "$VERIFY_ONLY" = 1 ]; then
  [ -n "$existing" ] || { bad "no Secret $NAMESPACE/$SECRET"; exit 1; }
  TOKEN=$(printf '%s' "$existing" | base64 -d)
else
  cat <<EOF
    Log in to Rancher as $USERNAME (a private window is easiest), then Account & API Keys >
    Create API Key, Scope: No Scope. A key created from another session belongs to that user,
    whatever it is called. Paste its Bearer Token below (it is not shown).
EOF
  [ -n "$existing" ] && echo "    (Enter to keep the token in the existing Secret)"
  read -r -s -p "  Token: " TOKEN; echo
  [ -z "$TOKEN" ] && [ -n "$existing" ] && TOKEN=$(printf '%s' "$existing" | base64 -d)
  [ -n "$TOKEN" ] || { bad "no token"; exit 1; }
fi
TID=${TOKEN%%:*}
owner=$("${K[@]}" get tokens.management.cattle.io "$TID" -o jsonpath='{.userId}|{.clusterName}|{.expiresAt}' 2>/dev/null || true)
IFS='|' read -r owner_id owner_cluster expires <<< "$owner"
if [ -z "$owner_id" ]; then bad "token $TID is not a Rancher API token"; exit 1; fi
if [ "$owner_id" != "$USER_ID" ]; then
  bad "token $TID belongs to $owner_id, not $USERNAME ($USER_ID): create it while logged in as $USERNAME"; exit 1; fi
if [ -n "$owner_cluster" ]; then
  bad "token $TID is scoped to cluster $owner_cluster: create one with No Scope"; exit 1; fi
ok "token $TID is $USERNAME's, not scoped${expires:+, expires $expires}"

step "4. Rancher's URL and CA"
URL=$("${K[@]}" get settings.management.cattle.io server-url -o jsonpath='{.value}')
"${K[@]}" get settings.management.cattle.io cacerts -o jsonpath='{.value}' > "$TMP/ca.crt"
ok "Rancher is $URL"
CURL=(curl -s --max-time 30)
if [ -s "$TMP/ca.crt" ]; then
  if curl -s --max-time 15 -o /dev/null --cacert "$TMP/ca.crt" "$URL/healthz"; then ok "its certificate is signed by its own CA (cacerts): ca.crt goes in the Secret"; CURL+=(--cacert "$TMP/ca.crt")
  else bad "cannot verify $URL with its cacerts setting"; fi
else
  : > "$TMP/ca.crt"; ok "no private CA (a publicly trusted certificate): no ca.crt needed"
fi

step "5. The Secret $NAMESPACE/$SECRET"
if [ "$VERIFY_ONLY" = 1 ]; then
  keys=$("${K[@]}" -n "$NAMESPACE" get secret "$SECRET" -o jsonpath='{.data}' | python3 -c 'import json,sys; print(" ".join(sorted(json.load(sys.stdin))))')
  surl=$("${K[@]}" -n "$NAMESPACE" get secret "$SECRET" -o jsonpath='{.data.url}' | base64 -d)
  [ "$surl" = "$URL" ] && ok "url is $URL" || bad "url is \"$surl\", Rancher is $URL"
  ok "keys: $keys"
else
  args=(--from-literal=url="$URL" --from-file=token=/dev/stdin)
  [ -s "$TMP/ca.crt" ] && args+=(--from-file=ca.crt="$TMP/ca.crt")
  if ask "Create or update $NAMESPACE/$SECRET (url, token$([ -s "$TMP/ca.crt" ] && echo ', ca.crt'))?"; then
    printf '%s' "$TOKEN" | "${K[@]}" -n "$NAMESPACE" create secret generic "$SECRET" "${args[@]}" --dry-run=client -o yaml | "${K[@]}" apply -f - | sed 's/^/    /'
  else bad "Secret not written"; fi
fi

step "6. As $USERNAME, through Rancher, on each cluster"
review() { # verb resource group namespace -> allowed?
  "${CURL[@]}" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$1/apis/authorization.k8s.io/v1/selfsubjectaccessreviews" \
    -d "{\"apiVersion\":\"authorization.k8s.io/v1\",\"kind\":\"SelfSubjectAccessReview\",\"spec\":{\"resourceAttributes\":{\"namespace\":\"$5\",\"verb\":\"$2\",\"resource\":\"$3\",\"group\":\"$4\"}}}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",{}).get("allowed", False))'
}
for c in "${CLUSTER_LIST[@]}"; do
  B="$URL/k8s/clusters/$c"
  code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$B/version")
  [ "$code" = 200 ] && ok "$(label "$c"): reachable" || { bad "$(label "$c"): Rancher's proxy answered $code"; continue; }
  code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$B/api/v1/nodes?limit=1")
  [ "$code" = 200 ] && ok "$(label "$c"): can read nodes (the chart's pre-flight)" || bad "$(label "$c"): cannot read nodes ($code)"
  nss=$("${CURL[@]}" -H "Authorization: Bearer $TOKEN" "$B/v1/namespaces?limit=-1" \
    | python3 -c "import json,sys; print(' '.join(n['metadata']['name'] for n in json.load(sys.stdin).get('data',[]) if n['metadata'].get('annotations',{}).get('field.cattle.io/projectId')=='$c:$PROJECT'))")
  [ -n "$nss" ] || { bad "$(label "$c"): no namespace in $PROJECT: add one (Projects & Quotas > Place on clusters creates them)"; continue; }
  for ns in $nss; do
    miss=""
    for r in "create jobs batch" "create secrets -" "create persistentvolumeclaims -" "get pods/log -"; do
      set -- $r; g=$3; [ "$g" = - ] && g=""
      [ "$(review "$B" "$1" "$2" "$g" "$ns")" = True ] || miss="$miss $1 $2,"
    done
    [ -z "$miss" ] && ok "$(label "$c")/$ns: can run AIJobs (Jobs, Secrets, PVCs, pod logs)" || bad "$(label "$c")/$ns: cannot${miss%,} (Rancher can take a minute to apply a new binding)"
  done
done
unset TOKEN

step "7. The operator"
cat <<EOF
  Set these chart values on the aif-operator release:

    manager:
      aijobRemoteClusters:
        allowedClusters:   # cluster IDs: a renamed cluster stays allowed, another with its name does not
$(for c in "${CLUSTER_LIST[@]}"; do echo "          - $c   # $(name_of "$c")"; done)
        secretName: $SECRET

  Then submit a run to one of them: rancher-ai run create --profile <profile> --cluster $(name_of "${CLUSTER_LIST[0]}")
EOF
[ "$FAILED" = 0 ] && printf '\n\033[32mReady.\033[0m\n' || { printf '\n\033[31mNot ready: fix the items marked ✗ and run again.\033[0m\n'; exit 1; }
