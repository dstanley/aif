# Data lifecycle: datasets, transfers and the Data Mover

This document proposes how AI Factory moves training data and training outputs: datasets as a
resource, one data-movement primitive (`DataTransfer`, executed by a Data Mover Job) for ingest,
staging, collection, archive and restore, and retention that separates a run's record from its
artifacts. It builds on the AIJob record (`aijob.md`), the `gpu-train-job` chart's dataset and
checkpoint volumes, the `rancher_ai` SDK, and the training agent on AI-enabled clusters.

## Goal

A governed lifecycle for training data and training outputs, in which data scientists work with
**datasets** and **training runs**, and AI Factory decides how bytes move and where they are kept:

**Ingest → Train → Retain → Archive → Restore**

The user does not need to know the object-storage implementation, S3 transfer tuning, Kubernetes
Jobs or storage tiers. A notebook is the control surface; large data moves close to the storage.

## Principles

1. **The user manages datasets; AI Factory manages how the bytes move.** Notebook-sized local data
   is uploaded by the SDK; data that already sits in reachable storage is moved server-side.
2. **One data-movement primitive.** A `DataTransfer` resource, executed by a Data Mover Job, serves
   ingest, staging, collection, archive and restore, rather than five mechanisms.
3. **Run history and run artifacts have different lifecycles.** The AIJob record stays searchable
   after its large artifacts move to archive storage or are deleted.
4. **Storage is a named capability, not a product.** Users refer to storage targets such as
   `default`, `research-s3` or `cold-storage`. AI Factory requires S3-compatible object storage for
   active data; Ceph RGW, an on-premises object store, a cloud object service or another S3-compatible
   platform can provide it.
5. **Credentials stay with the platform.** Users and notebooks never receive a storage target's
   credentials.

## What exists today

| Piece | Behaviour | Gap this spec closes |
|---|---|---|
| `gpu-train-job` chart | `storage.datasetPVC` mounts a dataset volume at `/mnt/dataset`; `storage.checkpointCreate` makes a per-run volume, optionally kept after the run (`<run>-checkpoints`) | No notion of a dataset in S3; outputs stay on a volume |
| SDK | `runs.create(dataset="<pvc>")`; `checkpoints.list/get/copy/delete` for kept volumes | No upload, ingest or registration of datasets; no artifact publishing |
| AIJob | Durable record; `spec.retention.executionObjects` (default 168h) removes the Job and pods, keeps the record and `status.report` | No artifact manifest or artifact state; volumes outlive their retention unless removed by hand |
| Kept volumes | The Jobs page lists kept checkpoint volumes, including those without a run | Grows without bound; no archive tier |

### Evidence from the lab (2026-10-06)

The ingest → stage → read path was exercised on the lab cluster with SeaweedFS as the
S3-compatible store and its CSI driver for the RWX volume (one volume server on a Longhorn volume,
lab VMs; functional evidence, not production throughput):

| Step | Tool | Result |
|---|---|---|
| Upload 20 CSV files, 2.6 GB, to S3 | `rclone copy`, 8 transfers, multipart (16 MiB parts) | 11 s (217 MB/s); `rclone check`: 0 differences |
| Stage: CSV in S3 → Parquet on an RWX volume | `pyarrow` reading S3, writing Parquet (zstd) | 30,000,000 rows, 20 shards, 75 s (35 MB/s of CSV) |
| Read on two nodes, mounted read-only | `pyarrow` | Both pods read all 30,000,000 rows, matching the manifest; writes refused |

The job definitions are the starting point for the Data Mover's `stage` operation.

## Concepts

### StorageTarget (cluster-scoped, administrator)

A named location AI Factory reads and writes through the S3 API.

```yaml
apiVersion: ai-factory.suse.com/v1alpha1
kind: StorageTarget
metadata:
  name: default
spec:
  class: Active                      # Active | Archive
  endpoint: https://s3.storage.example.com
  ingestEndpoint: https://s3-ingest.storage.example.com   # optional: high-bandwidth path for bulk transfers
  bucket: ai-factory
  prefix: ""                          # objects live under <prefix>/<project>/...
  region: us-east-1
  credentialsSecretRef: { name: default-s3, namespace: aif-operator }
  tls: { caSecretRef: { name: storage-ca, namespace: aif-operator } }
  moverPlacement:                     # where Data Mover Jobs for this target run
    nodeSelector: { storage-network: "true" }
  projects: ["*"]                     # which projects may use the target (policy; see Security)
status:
  conditions: [{ type: Reachable, status: "True" }]
```

- The storage administrator provides the endpoints, capacity and network connectivity; AI Factory
  consumes them.
- `ingestEndpoint` is used for bulk transfers, reachable over the storage network or a dedicated
  ingest route, never the shared application ingress.
- An initial deployment has two targets: `default` (Active) and `cold-storage` (Archive). Project
  overrides are out of the first iteration.

### Dataset (namespaced, in the project)

```yaml
apiVersion: ai-factory.suse.com/v1alpha1
kind: Dataset
metadata:
  name: qwen-training
  namespace: team-a
spec:
  storage: default
  prefix: datasets/qwen-training/v1/  # under the target's <prefix>/team-a/
  version: v1
  origin: { type: ingest, source: { storage: research-s3, prefix: qwen-training/ } }   # upload | ingest | register
status:
  phase: Ready                         # Pending | Importing | Verifying | Ready | Failed
  objects: 4210
  bytes: 1320000000000
  manifest: { object: datasets/qwen-training/v1/.aif-manifest.json, sha256: "…" }
  transfer: ingest-qwen-training-v1    # the DataTransfer that produced it
```

A dataset version is immutable once `Ready`. A new version is a new Dataset (or a new `version`),
so every run records exactly the data it used.

### DataTransfer (namespaced) and the Data Mover

```yaml
apiVersion: ai-factory.suse.com/v1alpha1
kind: DataTransfer
metadata:
  name: ingest-qwen-training-v1
  namespace: team-a
spec:
  operation: ingest                    # ingest | stage | collect | archive | restore
  source:      { storage: research-s3, prefix: qwen-training/ }
  destination: { storage: default, prefix: datasets/qwen-training/v1/ }
  verify: true
status:
  phase: Running                       # Pending | Running | Verifying | Completed | Failed
  bytesTotal: 1320000000000
  bytesDone: 437000000000
  objectsDone: 1390
  startedAt: …
  conditions: […]
```

The operator reconciles a DataTransfer by creating a **Data Mover Job**:

- a transfer engine (`rclone` or `s5cmd`; `rclone` covers S3, volumes, NFS and HTTP with one tool
  and was used in the lab test) with parallel and multipart transfers, retries and resume;
- credentials mounted from the targets' Secrets into the Job only, in the operator's namespace or a
  mover namespace, never the project's;
- placement from the targets' `moverPlacement`, so bulk traffic uses nodes on the storage network;
- progress written back to the DataTransfer's status (bytes and objects done), so the UI and SDK
  can show it without the Job's logs;
- verification: a manifest of object keys, sizes and SHA-256 written by the mover, checked after the
  copy. (A multipart object's ETag is not an MD5 of the object; S3 additional checksums are used
  where the store supports them.)

Operations:

| Operation | From → to | Used by |
|---|---|---|
| `ingest` | S3 → S3 | `datasets.ingest()` |
| `stage` | S3 → RWX volume | a run that reads its dataset as files (below) |
| `collect` | run volume → S3 | run completion: publish the artifacts the policy keeps |
| `archive` | S3 Active → S3 Archive | retention |
| `restore` | S3 Archive → S3 Active | `run.restore()`, the UI's Restore |

Later sources: NFS → S3, HTTP(S) → S3.

## Getting data in

| Source of the data | Path | Data flows through |
|---|---|---|
| The user's workstation or notebook | `datasets.upload("./data", name=…)` | the workstation, to the target's endpoint |
| Storage the cluster can reach | `datasets.ingest(source="s3://…", name=…)` | a Data Mover Job, never the notebook |
| Storage AI Factory can already read | `datasets.register("s3://…", name=…)` | nothing: a record only |

Source location matters more than size: 500 GB that exists only on a laptop has to travel through
the laptop; 500 GB already in another S3 store is moved server-side. A configurable soft limit on
interactive uploads (default 100 GiB) makes the SDK recommend `ingest` above it; an optional hard
limit refuses.

### Local upload without handing out credentials

The SDK uploads with a Python-native S3 client (no `s5cmd` or `rclone` on the workstation):
multipart, concurrent, retried, with progress and a SHA-256 per object. It does not receive the
target's credentials. Instead, the operator API issues **presigned URLs** for the multipart upload
(create, one URL per part, complete) scoped to the new dataset's prefix and valid for the upload's
duration, after checking the user may create a Dataset in the project and use the target. The
dataset becomes `Ready` after the operator verifies the manifest the SDK uploads last.

Presigned multipart upload is part of the S3 API and supported by Ceph RGW and SeaweedFS; a target
whose store does not support it falls back to `ingest` from a staging bucket the user can write to.

### Register

`register` records an existing prefix as a dataset after a read check and a manifest pass (keys and
sizes; checksums optional for very large sets). Useful where enterprise data already lives in
approved object storage.

## Training on a dataset

A run names a dataset, not a volume:

```python
run = ai.runs.create(profile="gpu-development", dataset="qwen-training", script="train.py")
```

Two ways to read it, chosen by the profile (or the run, where the profile opens it):

| Access | How | Suits |
|---|---|---|
| **Stream from S3** | The run receives the dataset's endpoint, bucket, prefix and short-lived read credentials (or a presigned listing); loaders read S3 directly (Hugging Face `datasets`, PyArrow, WebDataset, Ray Data) | Parquet and sharded formats; no copy |
| **Staged files** | A `stage` DataTransfer copies the dataset once onto a read-only RWX volume, cached per dataset version and reused by later runs; the chart mounts it at `/mnt/dataset` as today | Code that expects a filesystem; small-file datasets |

Staging is what the lab test exercised. The cache of staged volumes has its own retention (for
example, removed 7 days after the last run that used it).

## Outputs and the run record

A run writes checkpoints to its fast run volume (block storage), as today. On completion the
operator applies the run's **artifact policy**:

1. A `collect` DataTransfer copies the artifacts the policy keeps (final model or adapter, best
   checkpoint, logs, evaluation results) from the run volume to the Active target, under
   `runs/<project>/<run>/`, with a manifest.
2. The run volume is deleted once collection is verified, or after its warm period if the policy
   keeps it for resumption.
3. The AIJob records what was kept and where.

```yaml
status:
  phase: Succeeded                     # the run's outcome; never changed by artifact movement
  artifacts:
    state: Active                      # Collecting | Active | Archiving | Archived | Restoring | Deleted | Failed
    storage: default
    prefix: runs/team-a/suse-lora-042/
    bytes: 187000000000
    manifest: runs/team-a/suse-lora-042/.aif-manifest.json
    items:
      - { name: adapter, kind: adapter, path: adapter/, bytes: 52000000 }
      - { name: best, kind: checkpoint, path: checkpoints/step-1200/, bytes: 112000000000 }
    archivedAt: …
```

Artifact state is separate from `status.phase`: a run stays `Succeeded` while its artifacts move
between tiers. The record (identity, owner, profile and its version, dataset and version,
parameters, timings, outcome, report, artifact manifest, archive location) stays searchable for
the record's own retention, independent of the artifacts.

Publishing a model or adapter to a registry (for example MLflow, with the Active target as its
artifact store) reads from the collected location; it is a separate step and not part of this spec.

## Retention

```yaml
# operator configuration (global), later overridable per project or profile
retention:
  completedRuns:
    runVolume: 0d                      # delete the run volume after collection (or e.g. 7d warm)
    active: 30d                        # artifacts on the Active target
    archive: 335d                      # then on the Archive target
    record: 3y                         # the AIJob record itself
  artifactClasses:
    metadata: keep                     # record, metrics, evaluation summary
    logs: archive
    final: archive                     # final model or adapter
    best: archive                      # best checkpoint
    intermediate: { delete: 7d }       # other checkpoints
    workspace: delete                  # scratch
```

Two capacity facts drive the defaults: a full checkpoint with Adam in mixed precision is roughly
14–16 bytes per parameter (about 100–110 GB for 7B, 480–550 GB for 34B), while an adapter is
megabytes. Keeping every intermediate checkpoint is what fills storage; keeping adapters and the
best checkpoint costs little.

## Archive and restore

Archive is a `DataTransfer` from Active to Archive, followed by deletion of the Active copy.
The Archive target is implementation-neutral: a lower-cost tier or pool of the same store, a
separate object store, S3-compatible archival or tape-backed storage, or a cloud archive where
policy allows.

Restore copies Active-ready artifacts back and sets `artifacts.state` to `Restoring`, then `Active`.
For an archive tier with retrieval delays (an S3 restore request before objects can be read), the
transfer waits in `Pending` with the reason, and the UI says so. Restored artifacts get a fresh
active period.

Once restored, the usual actions work again: browse and download files, evaluate, resume training
from a checkpoint, publish.

## Where it runs (AI-enabled clusters)

StorageTargets, Datasets and DataTransfers live on the cluster whose workloads use them, alongside
AIJobs: the training agent on each AI-enabled cluster reconciles them, and Data Mover Jobs run on
that cluster, close to its storage network. A target can be shared by several clusters (the same
object store); each cluster has its own StorageTarget object pointing at it, delivered with the
agent. AI Factory's central view lists datasets and runs across clusters, as the Jobs list does.

## Security and policy

- Target credentials exist only in Secrets in the operator's (or a mover) namespace; Data Mover Jobs
  mount them; users get presigned URLs or short-lived read credentials scoped to one prefix.
- Objects are laid out per project (`<prefix>/<project>/datasets/…`, `…/runs/…`), so a credential
  or URL scoped to a project prefix cannot reach another project's data.
- `StorageTarget.spec.projects` limits which projects may use a target; a compute profile may limit
  which targets and datasets its runs may use, enforced by the compute-profile admission policy
  with the profile's other rules (`compute-profiles.md`).
- DataTransfers are created by the operator on the user's behalf (ingest, restore) or by retention;
  the user's right to request one is checked against the Dataset or AIJob it concerns.
- Every transfer is recorded on its DataTransfer (who, what, where, bytes, result), which is the
  audit trail.

## User experience

Users see datasets, runs and artifacts; DataTransfers and Jobs appear only as detail for
troubleshooting.

- **Datasets** (per cluster, in AI Training): name, version, size, source, status; an import shows
  progress (`437 GB of 1.2 TB, 36%`).
- **A run's detail:** its artifacts (state, size, storage), with Download, Restore and Delete.
- **SDK:**

```python
ds = ai.datasets.upload("./training-data", name="training-v2")        # local
ds = ai.datasets.ingest(source="s3://research-data/training-v2/", name="training-v2")
ds.wait()
run = ai.runs.create(profile="gpu-development", dataset=ds, script="train.py")
run.wait()
run.artifacts()                                                        # manifest
run.restore(); run.wait_artifacts()                                    # months later
```

## Order of work

| # | Change |
|---|---|
| 1 | `StorageTarget` resource and its reachability check; the operator's Data Mover Job (rclone) with progress and manifest verification |
| 2 | `DataTransfer` with `ingest` and `stage`; `Dataset` with `ingest` and `register`; SDK `datasets.ingest/register/list/get/delete` |
| 3 | Runs that name a dataset: staged (`/mnt/dataset`, as today) and streamed (credentials or presigned access) |
| 4 | `datasets.upload` through presigned multipart URLs from the operator API, with the soft limit |
| 5 | Artifact policy, `collect` on completion, `status.artifacts`, run-volume cleanup |
| 6 | Retention, `archive` and `restore`; UI for datasets, artifacts and restore |
| 7 | Profiles that limit targets and datasets |

1 and 2 deliver managed ingest on their own; 5 is what bounds storage growth.

## Open questions

1. **Transfer engine:** rclone (one tool for S3, volumes, NFS, HTTP; used in the lab test) or
   s5cmd (faster on many small objects, S3 only), or both by operation.
2. **Streaming credentials:** short-lived S3 credentials (requires an STS-capable store, such as Ceph
   RGW's STS) or presigned URLs (works everywhere, awkward for listing large prefixes).
3. **Collection timing:** at completion only, or periodically during long runs so a lost run volume
   loses less.
4. **Dataset scope:** project-only, or shareable read-only with other projects (a grant on the
   Dataset).
5. **Archive deletion:** whether removing the Active copy waits for a verification read from the
   Archive target.
6. **Registry integration:** whether publishing to MLflow is a Data Mover operation (`publish`) or
   left to the model-registry work.

## Out of scope

Data preprocessing and transformation (beyond staging), feature stores, data versioning tools
(DVC, lakeFS), backup of the object store itself, and storage capacity planning.
