# Training Workloads, Profiles and Projects Design

**Date:** 2026-10-03
**Depends on:** [AIJob design](../../design/aijob.md) (the AIJob API and controller)

## Goal

Let AI Factory run training and fine-tuning jobs alongside the inference
workloads it deploys today, and show who owns GPU capacity and what they are
using. Users work with three concepts: a **project** owns capacity, a
**profile** is a reusable compute policy, and a **workload** is what runs.
Queues, quotas, DRA claims and the GPU scheduler stay behind those three; AI
Factory has no Scheduler section.

This document proposes the navigation, the pages, the decisions needed before
the code, and a sequence of small pull requests. Each pull request is useful on
its own.

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
Overview      workloads first, then GPU capacity and projects
Catalog       what users deploy: apps, blueprints, training and inference profiles
Deployments   what is running: training runs, inference endpoints, applications
Settings      General, Projects & Quotas, Blueprints, Compute Profiles
About
```

The split is by who does what. A user browses the **Catalog** and deploys; what
they deployed is under **Deployments**; a platform engineer sets up projects,
quotas, blueprints and profiles under **Settings**. Apps, Blueprints and
Workloads stop being top-level entries: Apps and Blueprints are Catalog tabs,
Workloads is renamed Deployments, and the old routes still open their pages.

## Pages

### Overview

What is running comes first, capacity beside it:

```text
Workloads 7      Running 5       With issues 0      Projects 3     [Deploy ▾]

Recent workloads                         GPU capacity
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

A blueprint that an inference profile deploys is listed through that profile.
The blueprint's own install is still in the profile's menu, and a setting
shows wrapped blueprints too. Below the deployable cards, a collapsed
**Validate your environment** section holds the test and benchmark profiles
(see *Test and benchmark profiles*).

### Deployments

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

### Submit a training job

Deploying a training profile opens the submit form, which creates an AIJob. Its
first fields set the context:

```text
Project   [ team-a ▾ ]
Profile   [ single-gpu-finetune ▾ ]
Code      an inline script, a ConfigMap, or the profile's built-in demo
Workload  image, arguments, GPUs, data and output volumes
```

The code is a section of its own and must be chosen: a job without code would
run only the image's default command.

The profile supplies the chart, GPU request, limits and defaults, and says
which fields a user may change. Pre-flight checks run before submit, as advice
(the queue exists, the volumes exist, the image reference is valid, the
request fits the project's quota, the local disk fits a node, code imports what
the image provides). A check that only reflects the cluster's free capacity at
that moment does not block: under a queue the job waits. A request no node can
ever meet does.

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
- its GPU entitlement (guaranteed, or a limit with borrowing) and current use,
  in GPUs and GPU memory;
- running and queued workloads;
- **Edit quota**, which writes the scheduler's quota for the project.

The page translates a project into whatever the cluster's scheduler uses: a
ResourceQuota per namespace with no queueing scheduler, a Kueue LocalQueue and
ClusterQueue, or a KAI queue. A **Configure GPU scheduling** panel says which
one is in use and what is missing. Queues that belong to no project are kept
under **Advanced scheduling**, and only when the scheduler has them.

### Test and benchmark profiles

Profiles whose purpose is test or benchmark check the environment layer by
layer, so a failure points at one layer:

| Profile | Checks |
|---|---|
| GPU Smoke Test | driver, CUDA, device memory |
| PyTorch GPU Test | CUDA through PyTorch, FP32/FP16/BF16 matmul, training steps |
| PyTorch Distributed Test | torchrun rendezvous, NCCL, all-reduce, DDP |
| NCCL Fabric Benchmark | all-reduce bus bandwidth between nodes |
| Training + Storage Test | dataset → GPU → checkpoint and back, with throughput |
| GPU Diagnostics Bundle | what NVIDIA support asks for first, as a kept .tar.gz, with ECC, throttling, PCIe width and persistence-mode checks |
| GPU Health Check | NVIDIA DCGM diagnostics |

Each test's script ends with one `AIF_RESULT` JSON line (checks, metrics,
environment), which the run's detail and the SDK read. Smoke, PyTorch GPU and
the bundle also come on a GPU-memory share, so they run beside other
workloads.

## Python SDK and CLI

A client library (`rancher_ai`) and `rancher-ai` command line for notebooks and
scripts: list profiles, submit and follow jobs, read logs and results, deploy
and chat with inference endpoints, and list, read and delete kept checkpoint
volumes. It creates AIJobs through the Kubernetes API with the caller's own
credentials (kubeconfig, a Rancher token, or a pod's service account), so the
same RBAC applies as in the UI.

## Decisions for review

1. **The training chart.** An AIJob installs a chart from a ClusterRepo. A
   general training chart (single node, multi-node with torchrun, GPU shares,
   checkpoint and scratch volumes) needs a home: the SUSE AI catalog, or
   `charts/` in this repository. Until then the UI has no default address
   and asks for one when the chart's ClusterRepo is missing.
2. **How profiles are stored.** Either a custom resource (`AIProfile`,
   validated by the CRD and served by the operator API like Blueprints), or
   labelled ConfigMaps in one namespace. A custom resource is proposed.
3. **Which GPU schedulers are supported.** ResourceQuota (no queueing) and
   Kueue first. KAI adds GPU-memory shares with queueing; whether it is
   supported is a product decision.
4. **Where the SDK lives.** `sdk/python` in this repository with its own CI
   workflow, or a separate repository.

## Pull requests

| # | Change | Needs |
|---|---|---|
| 1 | AIJob API and controller | none |
| 2 | AIJob list, cancel and delete in the operator API | 1 |
| 3 | Training pages: profiles, submit with pre-flight checks, Projects & Quotas, Training tab and run detail | 2, decisions 1–3 |
| 4 | Navigation: Catalog, Deployments, a workload-first Overview, Settings tabs | 3 |
| 5 | Test and benchmark profiles, and results in the run detail | 3 |
| 6 | Python SDK and CLI | 1, decision 4 |

Sample profiles, blueprints and roles go in `examples/training` with the pull
request that first uses them. Each pull request adds its strings to
`l10n/en-us.yaml`, its tests, and a `docs/release-notes/unreleased.md` entry,
and keeps to the commit convention.

## Out of scope

- Cost reporting, storage quotas, and multi-cluster job placement.
- Hyperparameter sweeps and pipelines.
