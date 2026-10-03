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
Overview      capacity first, then projects and recent workloads
Projects      new
Profiles      new
Workloads     tabs: All, Training, Inference
Apps
Blueprints
Settings
About
```

Workloads keeps its name and route; training jobs join it as a tab. Projects
and Profiles are the only new entries.

## Pages

### Overview

Capacity becomes the first thing on the page:

```text
┌ GPU capacity ─────────────────────────────────────────────────────────┐
│  4 GPUs        2.5 GPUs allocated     1.5 GPUs available    2 queued  │
│  NVIDIA L40S   ███████████████░░░░░░░░░  62%                          │
│  3 projects    5 running workloads    2 queued              0 issues  │
└───────────────────────────────────────────────────────────────────────┘

Projects                                 Recent workloads
┌──────────────────────────────────┐     ┌─────────────────────────────┐
│ team-a  2 GPUs guaranteed        │     │ ● chat-endpoint  Inference  │
│ ███████░░░  1.5 GPUs · 2 running │     │   team-a · Running          │
│ team-b  up to 2 GPUs, shared     │     │ ● finetune-0412  Training   │
│ ███░░░░░░░  1 GPU · 1 queued     │     │   team-b · Queued           │
│                       View all → │     │                  View all → │
└──────────────────────────────────┘     └─────────────────────────────┘
```

Allocation is counted both in GPUs and in GPU memory, so fractional GPU shares
are shown correctly. The project summary is a compact list; quota editing and
membership stay on the Projects page.

### Workloads

- Tabs **All**, **Training** and **Inference**, filtered by `category` (on
  Blueprint, AIWorkload and AIJob).
- AIJobs are listed next to AIWorkloads with phase, project, profile, queue
  wait, duration and GPUs.
- Every row shows its project.
- A run's detail panel shows what was submitted, where each pod ran, exit
  codes and conditions, and links to logs once a logging backend is set.
- **Submit training job** opens the submit form.

### Submit a training job

The form creates an AIJob. Its first fields set the context:

```text
Project   [ team-a ▾ ]
Profile   [ single-gpu-finetune ▾ ]
Workload  image, script or command, data and output volumes
```

The profile supplies the chart, GPU request, limits and defaults, and says
which fields a user may change. Pre-flight checks run before submit, as advice
(the queue exists, the volumes exist, the image reference is valid, the
request fits the project's quota). A check that only reflects the cluster's
free capacity at that moment does not block: under a queue the job waits.

### Profiles

A profile is a named, reusable compute policy that a platform engineer
defines once and users pick from:

- the workload type (training or inference) and the chart it uses;
- the GPU request: whole GPUs per node, a GPU-memory share, or a DRA device
  class;
- CPU, memory and runtime limits; allowed images;
- storage: scratch space, and a checkpoint volume created per run and kept
  after it;
- which fields users may override, within which bounds.

The Profiles page lists profiles with the projects allowed to use them, and
edits them with a form and a YAML view.

### Projects

A project is a Rancher project. The page shows, for each one:

- its namespaces and members;
- its GPU entitlement (guaranteed, or a limit with borrowing) and current use,
  in GPUs and GPU memory;
- running and queued workloads;
- **Edit quota**, which writes the scheduler's quota for the project.

The page translates a project into whatever the cluster's scheduler uses: a
ResourceQuota per namespace with no queueing scheduler, a Kueue LocalQueue and
ClusterQueue, or a KAI queue. A **Configure GPU scheduling** panel says which
one is in use and what is missing.

## Python SDK and CLI

A client library and `aif` command line for notebooks and scripts: list
profiles, submit and follow jobs, read logs, and manage kept checkpoint
volumes. It creates AIJobs through the Kubernetes API with the caller's own
credentials (kubeconfig, a Rancher token, or a pod's service account), so the
same RBAC applies as in the UI.

## Decisions for review

1. **The training chart.** An AIJob installs a chart from a ClusterRepo. A
   general training chart (single node, multi-node with torchrun, GPU shares,
   checkpoint and scratch volumes) needs a home: the SUSE AI catalog, or
   `charts/` in this repository.
2. **How profiles are stored.** Either a custom resource (`AIProfile`,
   validated by the CRD and served by the operator API like Blueprints), or
   labelled ConfigMaps in the operator namespace. A custom resource is
   proposed.
3. **Which GPU schedulers are supported.** ResourceQuota (no queueing) and
   Kueue first. KAI adds GPU-memory shares with queueing; whether it is
   supported is a product decision.
4. **Where the SDK lives.** `sdk/python` in this repository with its own CI
   workflow, or a separate repository.

## Pull requests

| # | Change | Needs |
|---|---|---|
| 1 | AIJob API and controller | none |
| 2 | Workloads: Training and Inference tabs, AIJobs in the list, detail panel, delete; AIJob list and delete in the operator API | 1 |
| 3 | Submit a training job, with pre-flight checks | 2, decision 1 |
| 4 | Profiles page, and a profile picker in Submit and in Blueprint install | 3, decision 2 |
| 5 | GPU capacity on Overview (read-only) | none |
| 6 | Projects page: entitlement, use and quota per project; project on every workload | 5, decision 3 |
| 7 | Python SDK and CLI | 1, decision 4 |

Each pull request adds its strings to `l10n/en-us.yaml`, its tests, and a
`docs/release-notes/unreleased.md` entry, and keeps to the commit convention.

## Out of scope

- Renaming existing pages or routes.
- Cost reporting, storage quotas, and multi-cluster job placement.
- Hyperparameter sweeps and pipelines.
