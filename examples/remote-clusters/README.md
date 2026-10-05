# Runs on other clusters: setup

The AI Factory operator can install AIJobs on other Rancher-managed clusters (`spec.targetCluster`)
through Rancher's cluster proxy, acting there as a service user. `setup.sh` walks a Rancher admin
through it and checks each step:

```console
$ ./setup.sh --context <management-cluster-context> --clusters c-abc12,c-def34 --project p-training
$ ./setup.sh --context <management-cluster-context> --clusters c-abc12 --project p-training --verify-only
```

1. **The service user** (default `aif-operator`): you create it in Rancher, as a Standard User.
2. **Its rights on each cluster:** Cluster Member (the training chart's pre-flight reads nodes), and
   Project Owner of the project runs go to there. The script shows the bindings and asks before
   creating them.
3. **Its API token**, created while logged in as that user, with no scope. The script reads it without
   echo and checks that it is that user's: a key created from another user's session is that user's,
   whatever it is called.
4. **The Secret** the operator reads (default `aif-operator/aif-remote-clusters`): Rancher's URL, the
   token, and Rancher's CA when its certificate is self-signed (taken from the `cacerts` setting).
5. **A check as that user**, through Rancher, on each cluster: reachable, nodes readable, and in each of
   the project's namespaces the rights a run needs (Jobs, Secrets, PVCs, pod logs).
6. **The chart values** to set: `manager.aijobRemoteClusters.allowedClusters` and `.secretName`.

The project must exist on each cluster with the same ID, and with the namespaces runs use: Configure >
Projects & Quotas > *Place on clusters* creates both. `--verify-only` changes nothing and can be run
any time, for example after rotating the token.
