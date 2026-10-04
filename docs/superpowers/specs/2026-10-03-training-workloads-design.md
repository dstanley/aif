# Training Workloads, Profiles and Projects Design

**Date:** 2026-10-03
**Depends on:** [AIJob design](../../design/aijob.md) (the AIJob API and controller)

## Goal

Let AI Factory run training and fine-tuning jobs alongside the inference
workloads it deploys today, while making GPU ownership and consumption visible.

Users work with three primary concepts: a **project** owns a capacity
entitlement, a **profile** defines reusable compute policy, and a
**deployment** is an instance of something they run. Queues, quotas, DRA
claims and scheduler-specific resources remain implementation details behind
those concepts; AI Factory has no separate Scheduler section.

This document proposes the conceptual model, the navigation, the pages, the
decisions needed before the code, and a sequence of small pull requests. Each
pull request is useful on its own.

## Conceptual model

- **Project**: a tenancy and capacity boundary. It defines who may deploy and
  their GPU capacity entitlement: a guarantee, a limit, or both, not specific
  physical GPUs.
- **Compute profile**: reusable policy describing how a class of workload may
  run: compute, GPU allocation, storage, limits, defaults and the overrides a
  user may make. Profiles are cluster-level and shared across projects; a
  project uses a profile when it creates a deployment. Restricting a profile to
  some projects is not supported yet.
- **Deployment**: an instance created from the Catalog. Training deployments
  are finite and backed by AIJobs; inference endpoints and applications are
  long-running and backed by AIWorkloads.
- **Catalog**: the applications, blueprints and profiles available to deploy.

```text
Compute profile ─────┐
                     ├──▶ Deployment
Project ─────────────┘

                 Deployment
                /          \
         finite              long-running
           │                      │
         AIJob                AIWorkload
           │                      │
     Job / PyTorchJob      Helm release(s), through Fleet
           │                      │
         Pods                   Pods
```

Scheduler queues, quotas, DRA claims, Helm releases, Jobs and PyTorchJobs are
implementation details, shown only where they help diagnose a problem.

## Today

- **Workloads** lists AIWorkloads: long-running deployments of a Blueprint. The
  page reads them through the operator API (`utils/operator-api.ts`).
- A finite job (a training run) has no record: it is a Helm release that
  creates a Job, and once the Job's ttl passes nothing says what ran, where, or
  how it ended. AIJob is that record.
- **Overview** counts workloads. It does not show GPU capacity or what is
  waiting for it.

## Navigation

```text
Overview      deployments first, then GPU capacity and projects
Catalog       what users deploy: apps, blueprints, training and inference profiles
Deployments   what is running: training runs, inference endpoints, applications
Settings      General, Projects & Quotas, Blueprints, Compute Profiles
About
```

The information architecture follows the user's workflow: **Catalog** answers
"what can I deploy?", **Deployments** answers "what have I deployed?", and
**Settings** answers "how is the platform configured?". A user browses the
Catalog and deploys; a platform engineer sets up projects, quotas, blueprints
and profiles under Settings. Apps, Blueprints and Workloads stop being
top-level entries: Apps and Blueprints are Catalog tabs, Workloads is renamed
Deployments, and the old routes still open their pages.

## Pages

### Overview

What is running comes first, capacity beside it:

```text
Deployments 7    Running 5       With issues 0      Projects 3     [Deploy ▾]

Recent deployments                       GPU capacity
┌──────────────────────────────────┐     ┌─────────────────────────────┐
│ ● chat-endpoint   Inference      │     │ 4 GPUs · 2.5 allocated      │
│   team-a · Running               │     │ ███████████████░░░░░  62%   │
│ ● finetune-0412   Training       │     │ 1.5 available · 2 queued    │
│   team-b · Queued                │     ├ Projects ───────────────────┤
│                       View all → │     │ team-a  2 GPUs guaranteed   │
├ Active blueprints ───────────────┤     │ team-b  up to 2, shared     │
│ ...                              │     │                 View all →  │
└──────────────────────────────────┘     └─────────────────────────────┘
```

Allocation is counted both in GPUs and in GPU memory, so fractional GPU shares
are shown correctly. An application repository that cannot be read is a
one-line advisory with its details behind **View details**, not a full-width
error.

### Catalog

Tabs **All**, **Applications**, **Training** and **Inference**. The cards are:

- **Profiles**, deployed into a project on this cluster;
- **Blueprints**, deployed to any cluster through Fleet, with a version select,
  the vendor and a partner logo;
- **Apps** from the application catalog, with their icons.

When a profile provides the preferred deployment experience for a blueprint,
the Catalog presents the profile as the primary entry. The profile's menu keeps
an option to install the underlying blueprint directly, and a setting shows
such wrapped blueprints as separate entries. Below the deployable cards, a
collapsed **Validate your environment** section holds the test and benchmark
profiles (see *Test and benchmark profiles*).

### Deployments

A deployment is the UI's abstraction over finite and long-running execution:
training runs are backed by AIJobs, inference endpoints and applications by
AIWorkloads.

- Tabs **Training**, **Inference** and **Applications** under one toolbar,
  filtered by `category` (on Blueprint, AIWorkload and AIJob).
- AIJobs are listed next to AIWorkloads with phase, project, profile, queue
  wait, duration and GPUs.
- Every row shows its project.
- A run's detail panel shows what was submitted, where each pod ran, exit
  codes and conditions, and links to logs once a logging backend is set.
- A test or benchmark run's detail shows its results: each check (pass, fail,
  or pass with a warning), its metrics and the environment it ran in.
- **New deployment** opens the Catalog.

### Deploy training

Selecting a training profile in the Catalog opens a deployment form. Submitting
the form creates an AIJob. Its first fields set the context:

```text
Project   [ team-a ▾ ]
Profile   [ single-gpu-finetune ▾ ]
Code      an inline script, a ConfigMap, or the profile's built-in demo
Workload  image, arguments, GPUs, data and output volumes
```

The code is a section of its own and must be chosen: a job without code would
run only the image's default command.

The profile supplies the chart, GPU request, limits and defaults. Two kinds of
check run before submission:

- **Profile constraints are enforced.** Fields the profile does not expose
  cannot be changed, and values outside its bounds are rejected.
- **Cluster pre-flight checks advise** on the current environment: the queue
  exists, the volumes exist, the image reference is valid, the request fits the
  project's quota, local storage fits a node, and the code imports what the
  image provides. A transient capacity shortage does not block submission when
  the scheduler can queue the deployment. An impossible request, such as a GPU
  or local-storage requirement no eligible node can meet, does.

```text
Profile policy violation      → block
Temporary capacity shortage   → warn, then queue
Impossible placement          → block
```

The UI and the SDK apply the same contract.

### Profiles

A profile is a named, reusable compute policy that a platform engineer
defines once and users pick from:

- the workload type (training or inference), its purpose (training, test or
  benchmark) and the chart it uses;
- the GPU request: whole GPUs per node, a GPU-memory share, or a DRA device
  class;
- CPU, memory and runtime limits; allowed images;
- storage: scratch space, and a checkpoint volume created per run and kept
  after it;
- which fields users may override, within which bounds.

Profiles are deployed from the Catalog and edited under **Settings → Compute
Profiles**, with a form for training and for inference profiles, and **Edit
YAML** in each tile's menu. Each profile is marked Ready or Beta.

### Projects & Quotas

Under Settings. A project is a Rancher project. The page shows, for each one:

- its namespaces and members;
- its GPU capacity entitlement (guaranteed, or a limit with borrowing) and
  current use, in GPUs and GPU memory;
- running and queued deployments;
- **Edit**, which writes the project's quota.

The page maps the project's entitlement onto the cluster's resource-control
mechanism: a Kubernetes ResourceQuota per namespace when no queueing scheduler
is configured, a Kueue LocalQueue and ClusterQueue, or a KAI queue. A
**Configure GPU scheduling** panel says which one is in use and what is
missing. Queues that belong to no project are kept under **Advanced
scheduling**, and only when the scheduler has them.

### Test and benchmark profiles

Test and benchmark profiles form a progressive diagnostic ladder. Each stage
adds a layer of the AI stack, so a lower-level test that passes and a
higher-level test that fails narrow down where the fault is:

```text
GPU / CUDA
    ↓
PyTorch
    ↓
Distributed runtime / NCCL
    ↓
Inter-node fabric
    ↓
Training + storage
```

| Profile | Checks |
|---|---|
| GPU Smoke Test | driver, CUDA, device memory |
| PyTorch GPU Test | CUDA through PyTorch, FP32/FP16/BF16 matmul, training steps |
| PyTorch Distributed Test | torchrun rendezvous, NCCL, all-reduce, DDP |
| NCCL Fabric Benchmark | all-reduce bus bandwidth between nodes |
| Training + Storage Test | dataset → GPU → checkpoint and back, with throughput |
| GPU Diagnostics Bundle | collects the system and GPU diagnostics commonly required for NVIDIA support into a kept `.tar.gz`, and evaluates ECC errors, pending memory repair, throttling, temperature, PCIe link width (against the upstream port, not only the GPU's maximum) and persistence mode |
| GPU Health Check | NVIDIA DCGM diagnostics |

Each test's script ends with one `AIF_RESULT` JSON line (checks, metrics,
environment), which the run's detail and the SDK read. Smoke, PyTorch GPU and
the bundle also come on a GPU-memory share, so they run beside other
deployments.

## Python SDK and CLI

A Python client (`rancher_ai`) and `rancher-ai` CLI expose the same profile,
training, inference, result and checkpoint workflows for notebooks and
scripts. They support kubeconfig, Rancher API token and in-cluster
ServiceAccount authentication, and call the API with the caller's identity, so
the caller's RBAC decides what they may read and create. When a run is
submitted as an AIJob, the operator then installs its chart with the
operator's own service account, limited to the charts its allow-list permits.

## Decisions for review

1. **The training chart.** An AIJob installs a chart from a ClusterRepo. A
   general training chart (single node, multi-node with torchrun, GPU shares,
   checkpoint and scratch volumes) needs a home: the SUSE AI catalog, or
   `charts/` in this repository. Until then the UI has no default address
   and asks for one when the chart's ClusterRepo is missing.
   *Proposed:* the SUSE AI catalog, so the chart is versioned and released
   with the other SUSE AI charts.
2. **How profiles are stored.** Either a custom resource (`AIProfile`,
   validated by the CRD and served by the operator API like Blueprints), or
   labelled ConfigMaps in one namespace.
   *Proposed:* a custom resource, so profiles are validated on write and
   readable through the operator API.
3. **Which GPU scheduling is supported.** ResourceQuota (no queueing), Kueue,
   and KAI, which adds GPU-memory shares with queueing.
   *Proposed:* all three behind the same project model; whether KAI is
   supported is a product decision.
4. **Where the SDK lives.** `sdk/python` in this repository with its own CI
   workflow, or a separate repository.
   *Proposed:* `sdk/python` in this repository, so the SDK changes in the same
   pull request as the profile rules and APIs it mirrors.

## Pull requests

| # | Change | Needs |
|---|---|---|
| 1 | AIJob API and controller | none |
| 2 | AIJob list, cancel and delete in the operator API | 1 |
| 3 | Training pages: profiles, deploy with pre-flight checks, Projects & Quotas, Training tab and run detail | 2, decisions 1–3 |
| 4 | Navigation: Catalog, Deployments, a deployment-first Overview, Settings tabs | 3 |
| 5 | Test and benchmark profiles, and results in the run detail | 3 |
| 6 | Python SDK and CLI | 1, decision 4 |

Sample profiles, blueprints and roles go in `examples/training` with the pull
request that first uses them. Each pull request adds its strings to
`l10n/en-us.yaml`, its tests, and a `docs/release-notes/unreleased.md` entry,
and keeps to the commit convention.

## Out of scope

- Cost reporting, storage quotas, and multi-cluster job placement.
- Hyperparameter sweeps and pipelines.
