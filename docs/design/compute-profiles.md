# Compute profiles: portable, bound and enforced

This document proposes how AI Factory defines and enforces what users may deploy across clusters:
portable profile packs, bound to each cluster as `ComputeProfile` resources, granted to projects,
and enforced at Kubernetes admission by an AI Factory policy running on Kubewarden. It builds on
profile packs, AI-enabled clusters and the per-cluster AI Training section, remote AIJobs, and the
profile validation in the UI and the Python SDK.

## 1. Goal

AI Factory needs a consistent way to define and enforce **what users are allowed to deploy** across multiple clusters.

A compute profile should answer:

> **What may this user run, what may they change, and within what limits?**

For a training workload, a profile might define:

- framework and execution mode;
- container image and allowed registries;
- number of workers;
- GPUs per worker;
- storage configuration;
- maximum runtime;
- scheduler configuration;
- fields the user may change;
- limits on those editable fields.

For an inference endpoint, a profile additionally identifies the approved blueprint and version and fixes deployment settings that must not be changed.

The core principle is:

> **A compute profile is an enforceable platform contract, not merely a UI template.**

The same contract must apply whether the workload is submitted from the AI Factory UI, Python SDK, CLI, Jupyter notebook, or directly through the Kubernetes API.

AI Factory owns the profile model and validation semantics. **Kubewarden provides the Kubernetes admission enforcement point.**

## 2. Current problem

Profiles already describe much of this intent, but two architectural gaps prevent them from being authoritative.

### 2.1 Profiles are not enforced by the cluster

Today, profile rules are validated by the Deploy UI and Python SDK before submission.

The cluster itself does not enforce them.

For example:

```yaml
values:
  image: ...
  job:
    mode: torchrun
    nodes: 2
    gpusPerNode: 1

editable:
  - image
  - tag
  - script
  - args
  - env
  - nodes
  - gpusPerNode
  - datasetPVC
  - checkpointPVC
  - runtimeLimitHours

limits:
  nodes:
    min: 1
    max: 4

  gpusPerNode:
    min: 1
    max: 2

  registries:
    - dp.apps.rancher.io/containers/
    - nvcr.io/nvidia/
    - pytorch/

  maxRuntimeHours: 8
```

The UI may prevent a user from requesting six workers, but a user who can create an `AIJob` directly can currently bypass that check.

Likewise, `spec.profile` on an `AIJob` is currently informational rather than authoritative.

Inference endpoints have the same problem: an `AIWorkload` created from a profile is not currently validated against that profile by the cluster.

### 2.2 Profiles mix portable policy with cluster-specific configuration

Profiles are currently stored as ConfigMaps on individual clusters.

That mixes two different kinds of information:

```text
Portable intent
────────────────────────
framework
allowed image registries
worker limits
GPU limits
runtime limits
editable fields

Cluster-specific facts
────────────────────────
GPU type
storage class
scheduler
pull secret
runtime configuration
```

As a result, custom profiles must be copied and modified independently on each cluster.

AI Factory needs to separate the **portable definition of a profile** from the **cluster-specific profile users actually run**.

## 3. Profile model

The proposed model has four layers:

```text
               AI Factory
                    │
                    ▼
              Profile Pack
        portable/versioned definition
                    │
                    │ bind
                    ▼
              ComputeProfile
          configured for a cluster
                    │
                    │ allow
                    ▼
                 Project
                    │
                    │ use
                    ▼
                  User
              editable fields
               within limits
```

Each layer has a distinct responsibility.

## 4. Profile packs

A **Profile Pack** is the global, portable definition.

It is managed centrally in AI Factory by platform administrators.

A pack can contain one or more profile templates and describes:

- workload type;
- framework;
- blueprint/chart;
- required hardware capabilities;
- required platform capabilities;
- default values;
- editable fields;
- limits;
- approved registries;
- runtime constraints.

Profile Packs are:

- versioned;
- portable;
- centrally managed;
- independent of a specific cluster.

For example:

```text
pytorch-distributed
version: 1.3

Requires:
  NVIDIA GPU
  distributed training
  checkpoint storage

Allows:
  1–4 nodes
  1–2 GPUs/node
  runtime ≤ 8 hours
```

The pack says **what the platform intends to allow**.

It does not need to contain the exact storage class, scheduler configuration, pull secret, or GPU model for every cluster.

## 5. Bound compute profiles

Before a profile can be used on a cluster, AI Factory binds the portable profile to that cluster's capabilities and configuration.

The result is a **ComputeProfile**.

```text
Profile Pack
     +
Cluster Facts
     │
     ▼
ComputeProfile
```

For example:

```text
pytorch-distributed v1.3
        +
Cluster A
  GPU: A100
  Storage: fast-rwx
  Scheduler: KAI
  Pull Secret: registry-creds
        │
        ▼
pytorch-distributed
bound to Cluster A
```

A bound profile therefore contains everything necessary to validate and deploy the workload on that cluster.

Bound profiles are delivered by AI Factory and are read-only on the target cluster.

## 6. ComputeProfile resource

Profiles should move from unstructured ConfigMaps to a Kubernetes `ComputeProfile` resource.

Conceptually:

```yaml
apiVersion: ai-factory.suse.com/v1alpha1
kind: ComputeProfile

metadata:
  name: pytorch-distributed
  namespace: ai-profiles

spec:
  source:
    pack: pytorch-distributed
    version: "1.3"

  values:
    ...

  editable:
    - image
    - script
    - args
    - nodes
    - gpusPerNode
    - runtimeLimitHours

  limits:
    nodes:
      min: 1
      max: 4

    gpusPerNode:
      min: 1
      max: 2

    maxRuntimeHours: 8
```

The resource provides:

- API-server schema validation;
- explicit status;
- profile version information;
- cluster compatibility status;
- RBAC;
- printer columns;
- a stable API for the UI, SDK and policy layer.

During migration, AI Factory can continue reading existing ConfigMap profiles so current clusters remain functional.

## 7. Project entitlement

A profile existing on a cluster does not automatically mean every project may use it.

Projects explicitly receive access to profiles.

```text
Cluster Capacity
      │
      ▼
Project Quota
      │
      ▼
Allowed Profiles
      │
      ▼
User Workload
```

The distinction is:

> **Quota defines how much a project may consume. A profile defines the shape of workloads it may create.**

For example:

```text
Project: research-team

Quota
  GPUs: 16

Allowed profiles
  gpu-development
  pytorch-distributed
  inference-small
```

A project could have sixteen GPUs available but still be prevented from creating a workload that violates the limits of its approved profiles.

## 8. User customization

Users do not modify the profile itself.

They supply values only for fields explicitly marked as editable.

For example:

```python
ai.runs.create(
    profile="pytorch-distributed",
    nodes=3,
    script="train.py",
)
```

The profile might allow:

```text
nodes              1–4
gpusPerNode        1–2
image              approved registries
runtimeLimitHours  ≤ 8
script             editable
args               editable
```

Everything else remains fixed by the platform.

This produces a simple contract:

```text
Platform chooses the envelope
          │
          ▼
Project receives permission
          │
          ▼
User chooses within the envelope
```

## 9. Policy enforcement with Kubewarden

Client-side validation improves usability, but it cannot be the security boundary.

The authoritative check occurs during **Kubernetes admission**, using Kubewarden.

AI Factory provides the policy semantics; Kubewarden provides the policy execution and admission infrastructure.

```text
UI / SDK / CLI / Jupyter
          │
          ▼
   AIJob / AIWorkload
          │
          ▼
 Kubernetes Admission
          │
          ▼
      Kubewarden
          │
          ▼
 AI Factory Profile Policy
          │
     ┌────┴─────┐
     │          │
   Allow      Reject
     │          │
     ▼          ▼
 Operator    Clear reason
```

This means the policy applies regardless of how the Kubernetes object was created.

A user cannot bypass profile enforcement by avoiding the AI Factory UI or SDK.

## 10. AI Factory profile policy

AI Factory should provide a dedicated Kubewarden policy responsible for validating AI Factory workloads.

Conceptually:

```text
aif-compute-profile-policy
```

The policy applies to:

```text
AIJob
AIWorkload
```

and validates each workload against the `ComputeProfile` applicable to its target cluster.

The policy should remain deliberately narrow:

> **Determine whether an AI Factory workload conforms to its declared ComputeProfile and project entitlement.**

Kubewarden owns admission execution.

AI Factory owns the meaning of a valid AI Factory workload.

## 11. Context required by the policy

Profile validation is not purely an inspection of the submitted object.

The policy also needs authoritative cluster context.

Conceptually:

```text
              AIJob / AIWorkload
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
   ComputeProfile          Project Entitlement
          │                       │
          └───────────┬───────────┘
                      ▼
              Kubewarden Policy
                      │
                Allow / Reject
```

The policy therefore needs access to:

1. the submitted `AIJob` or `AIWorkload`;
2. the referenced `ComputeProfile`;
3. the profiles allowed for the object's project.

This should use Kubewarden's context-aware policy capabilities rather than calling an external AI Factory service during admission.

The admission path should remain local, deterministic and available whenever the Kubernetes API is available.

## 12. What the policy validates

For an object that names a profile, the AI Factory policy verifies:

### 1. The profile exists

The named `ComputeProfile` must exist for the target cluster.

It may be:

- centrally bound from AI Factory; or
- an allowed local profile.

### 2. The project may use it

The workload's project must be entitled to the profile.

### 3. Fixed values have not changed

Values must match the profile unless the field appears in `editable`.

### 4. Editable values remain within limits

For example:

```text
nodes              within min/max
GPUs per worker    within min/max
image              approved registry
runtime            ≤ maxRuntimeHours
```

The runtime limit must also be translated into the underlying Job's `activeDeadlineSeconds` so the limit is enforced during execution.

### 5. Inference endpoints use the approved blueprint

For inference workloads, the blueprint and version must match the profile.

## 13. Validation responsibilities

Profile validation exists at two levels for different reasons.

```text
                 ComputeProfile
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
        UI / SDK              Kubewarden
            │                     │
      User experience          Authority
            │                     │
      Early feedback        Admission decision
```

The UI and SDK continue validating locally because that gives users immediate and useful feedback.

Kubewarden is authoritative.

If client-side validation and admission disagree, the Kubewarden decision wins.

The AI Factory policy should be tested against the same validation cases used by the UI and SDK to minimize differences between the implementations.

## 14. Binding the profile to the run

`spec.profile` should become binding rather than informational.

An accepted AIJob records:

```text
Profile:          pytorch-distributed
Profile version:  1.3
```

This means the historical run records **the policy under which it was admitted**.

A future change to the profile does not change the meaning of an existing run record.

The same principle applies to inference endpoints.

## 15. Policy rollout

Profile enforcement can be introduced gradually rather than changing existing behavior in one release.

Initially, the AI Factory policy can run in **monitor mode**:

```text
Workload submitted
       │
       ▼
Kubewarden
       │
       ▼
Profile violation
       │
       ├── record/report violation
       │
       └── allow workload
```

This allows administrators to identify existing notebooks, scripts, or workflows that do not specify valid profiles.

Once environments are ready, the policy moves to **protect mode**:

```text
Workload submitted
       │
       ▼
Kubewarden
       │
       ▼
Profile violation
       │
       ▼
Reject workload
```

This provides a clean migration path from advisory profile validation to mandatory enforcement.

## 16. Administrative bypass

Some administrators or advanced users may need to create workloads outside a predefined profile.

That should require an explicit permission.

Conceptually:

```text
Normal user
   │
   └── must satisfy profile


AI Job Author
   │
   └── may submit custom workload
```

The bypass must be explicit and auditable.

One possible implementation is a Kubernetes authorization check against a dedicated permission such as:

```text
aijobs/custom
aiworkloads/custom
```

granted through a Rancher RoleTemplate such as **AI Job Author**.

The exact integration between the Kubewarden policy and Kubernetes authorization should be validated before this mechanism is finalized.

Importantly, bypassing a ComputeProfile does **not** bypass platform-wide security restrictions.

Controls such as:

- allowed charts;
- prohibited host networking;
- prohibited RDMA configuration;
- other mandatory platform policies;

continue to apply.

## 17. Local profiles

Clusters may continue to support **local profiles** for:

- clusters not centrally AI-enabled;
- development;
- experiments;
- migration from the existing implementation.

Local profiles are clearly identified as local.

They are enforced through the same Kubewarden policy as centrally bound profiles.

Whether centrally managed clusters should continue allowing local profiles long-term remains a policy decision.

## 18. Delivering profiles to clusters

AI Factory must turn installed Profile Packs into cluster-specific ComputeProfiles.

The preferred architecture is:

```text
AI Factory
    │
    ├── Profile Pack
    │
    ├── Cluster capabilities
    │
    └── Cluster configuration
           │
           ▼
      Binding Controller
           │
           ▼
    Fleet Bundle for Cluster A
           │
           ▼
       Cluster A
           │
           ├── ComputeProfiles
           │
           └── Kubewarden Policy
```

The central operator performs profile binding because it has visibility into both:

- the installed Profile Pack; and
- the capabilities/configuration of each AI-enabled cluster.

Fleet delivers the resulting profiles to the appropriate cluster.

The AI Factory Kubewarden policy is installed on AI-enabled clusters and provides consistent enforcement of those profiles.

## 19. Central and remote workloads

AI Factory supports workloads created directly on the cluster where they run as well as centrally managed workloads targeting another cluster.

The enforcement point should correspond to where the authoritative workload is admitted.

```text
Direct AIJob
     │
     ▼
Target Cluster
     │
     ▼
Kubewarden
     │
     ▼
Profile Policy
```

For centrally created resources such as an `AIWorkload` whose deployment is subsequently delivered to another cluster:

```text
AIWorkload
     │
     ▼
Management Cluster
     │
     ▼
Kubewarden
     │
     ▼
Profile Policy
     │
     ▼
Fleet
     │
     ▼
Target Cluster
```

The policy must evaluate the `ComputeProfile` bound for the workload's target cluster.

This keeps admission authoritative while preserving AI Factory's centralized deployment model.

## 20. Jupyter and SDK experience

The notebook workflow remains simple.

The SDK authenticates using the user's identity and retrieves only the profiles available to the user's project.

```python
profiles = ai.profiles.list()
```

The user then submits:

```python
run = ai.runs.create(
    profile="pytorch-distributed",
    nodes=3,
    script="train.py",
)
```

The end-to-end flow is:

```text
Jupyter
   │
   │ user's Rancher identity
   ▼
rancher_ai SDK
   │
   ├── discover allowed profiles
   ├── build values from profile
   └── validate locally
   │
   ▼
AIJob
   │
   ▼
Kubernetes Admission
   │
   ▼
Kubewarden
   │
   ▼
AI Factory Profile Policy
   │
   ├── profile exists
   ├── project may use it
   ├── fixed values unchanged
   └── editable values within limits
   │
   ▼
AIJob accepted
   │
   ▼
Operator deploys workload
```

Attempts to use:

- an unapproved image registry;
- six workers when the maximum is four;
- three GPUs per worker when the maximum is two;
- no runtime limit when one is required;

are rejected with a clear admission message.

The result is identical whether the workload came from Jupyter, the UI, CLI, or Kubernetes API.

## 21. Inference profiles

The same profile model applies to inference endpoints.

An inference profile controls **what may be deployed**:

```text
Inference Profile

Blueprint             SUSE Inference Endpoint
Blueprint version     approved version
Model/runtime         fixed or constrained
GPU configuration     fixed or constrained
Gateway configuration fixed
Editable fields       explicitly listed
```

Kubewarden validates the `AIWorkload` against the profile before the endpoint is accepted.

The profile reference should be part of the `AIWorkload` spec rather than only a label so it can be:

- required;
- validated;
- recorded;
- potentially immutable.

## 22. Deployment policy vs. request policy

Inference introduces an important distinction.

A ComputeProfile governs the **deployment**.

It does not govern every **request** subsequently sent to the deployed model.

These controls belong to different layers:

| Layer | Controls | Enforced by | When |
|---|---|---|---|
| **Profile** | Blueprint, version and deployment configuration | Kubewarden + AI Factory profile policy | Create/change |
| **Gateway** | Authentication, budgets, rate limits and content controls | LiteLLM or equivalent gateway | Every request |
| **Network** | Prevent direct access around the gateway | Kubernetes NetworkPolicy/CNI | Every connection |

Conceptually:

```text
            Inference Request
                   │
                   ▼
             Model Gateway
        auth / budget / guardrails
                   │
                   ▼
            Network Policy
         gateway-only model access
                   │
                   ▼
                 vLLM
```

Kubewarden therefore controls **whether the endpoint is allowed to exist in that configuration**.

The gateway controls **what callers may do with it once it exists**.

## 23. Inference security requirements

The current inference architecture exposes three important gaps that should be closed independently of the broader profile work.

### Gateway-only access

Model-serving pods should not be directly reachable by arbitrary workloads.

The inference blueprint should provide a `NetworkPolicy` allowing model traffic only from the approved gateway and required monitoring components.

```text
Notebook ─────────X────────► vLLM

Training Job ─────X────────► vLLM

User ─────► LiteLLM Gateway ─────► vLLM
              │
              ├── authentication
              ├── budget
              ├── rate limit
              └── guardrails
```

### Platform-owned gateway credentials

The LiteLLM master key should not be readable by ordinary project users.

It should reside in a platform-controlled location such as:

- an operator-controlled namespace;
- a protected namespace associated with the endpoint; or
- an external secret store.

Users receive scoped virtual keys rather than the gateway's administrative credential.

### Fixed gateway policy

Gateway settings that form part of platform security policy should be fixed by the inference profile.

For example:

- prompt-injection detection;
- content guardrails;
- exposed services;
- required gateway configuration.

Changing those settings requires explicit custom-workload permission.

## 24. UI model

The UI should expose the same hierarchy as the architecture.

### AI Factory

Platform administrators manage:

```text
AI Factory
   │
   └── Profile Packs
         ├── versions
         ├── requirements
         ├── target clusters
         └── binding status
```

Profile Packs can live alongside Blueprints or in a dedicated Profiles section.

### AI Training → Catalog

Each AI-enabled cluster shows the profiles actually available there:

```text
Catalog

Training
  GPU Development
  PyTorch Distributed

Inference
  Small Inference
  Shared GPU Inference
```

The Catalog includes centrally bound profiles and, where permitted, local profiles.

### Projects & Quotas

Project configuration shows both resource capacity and allowed workload shapes:

```text
Research Project

Quota
  GPUs:       16
  CPU:        ...
  Memory:     ...

Allowed Profiles
  ✓ GPU Development
  ✓ PyTorch Distributed
  ✓ Small Inference
```

### Deploy

For users operating within a profile, the Deploy experience does not materially change.

The form exposes only editable values and their limits.

If Kubewarden rejects the workload, the UI displays the admission reason.

## 25. Observability and compliance

Using Kubewarden provides an additional distinction between **enforcement** and **visibility**.

AI Factory should surface profile-policy violations in a way administrators can inspect.

For example:

```text
Cluster: gpu-cluster-1

Profile Policy
  Mode: Protect

Last 24 hours
  Allowed:     147
  Rejected:      3

Violations
  unapproved registry       1
  worker limit exceeded     1
  missing profile           1
```

During a monitor-mode rollout, this becomes particularly useful because administrators can identify incompatible workloads before enabling rejection.

The detailed policy/audit infrastructure remains Kubewarden's responsibility; AI Factory can surface the relevant status where useful.

## 26. Profile lifecycle

The resulting lifecycle is:

```text
Platform Administrator
        │
        ▼
 Create / Install Profile Pack
        │
        ▼
 AI Factory evaluates clusters
        │
        ▼
 Bind Pack to Cluster
        │
        ▼
 Create ComputeProfile
        │
        ▼
 Grant Profile to Project
        │
        ▼
 User submits workload
        │
        ▼
 Kubernetes Admission
        │
        ▼
 Kubewarden Profile Policy
        │
        ▼
 Workload accepted
        │
        ▼
 Run records profile + version
```

This creates a consistent policy chain from platform administration to individual workload execution.

## 27. Recommended implementation sequence

The implementation can be staged.

### Phase 0: close existing inference security gaps

Before introducing the broader profile architecture:

- add gateway-only `NetworkPolicy`;
- move the LiteLLM master key outside project-user access;
- add an appropriate content guardrail to the example inference blueprints.

These changes improve endpoints already being deployed.

### Phase 1: prove Kubewarden enforcement

Implement a minimal AI Factory Kubewarden policy for existing profiles.

Validate:

- AIJob admission;
- ComputeProfile/context lookup;
- project entitlement lookup;
- useful rejection messages;
- monitor vs. protect rollout;
- custom-workload authorization/bypass.

This is the key architectural spike.

### Phase 2: make existing profiles authoritative

Implement:

- common profile-validation semantics;
- binding of `spec.profile`;
- profile version recording;
- project-to-profile entitlement;
- authoritative Kubewarden enforcement.

The UI and SDK retain their existing client-side validation.

### Phase 3: apply profiles to inference

Add:

- AIWorkload profile field;
- inference-profile validation through Kubewarden;
- fixed gateway configuration.

### Phase 4: make profiles portable

Add:

- `ComputeProfile` CRD;
- compatibility with existing ConfigMap profiles during migration;
- Profile Packs;
- per-cluster binding;
- Fleet delivery.

### Phase 5: complete the management experience

Add:

- Profile Packs in AI Factory;
- training and inference profiles in each cluster's Catalog;
- allowed profiles in Projects & Quotas;
- binding/compatibility status;
- useful policy/compliance status.

## 28. Open questions

The remaining design decisions are:

**Kubewarden context:** Confirm the cleanest mechanism for resolving `ComputeProfile` and project entitlement during admission.

**Administrative bypass:** Validate whether the AI Factory Kubewarden policy can cleanly perform the required Kubernetes authorization check, or whether the bypass should be represented differently.

**Policy distribution:** Decide whether the AI Factory policy is installed as part of the AI-enabled cluster bundle or managed separately as part of the platform's Kubewarden installation.

**Kubewarden dependency:** Decide whether Kubewarden is required for AI-enabled clusters or whether AI Factory must support a fallback admission mechanism where Kubewarden is unavailable.

**Profile delivery:** Confirm per-cluster Fleet Bundles as the profile binding and delivery mechanism.

**Migration strictness:** Determine how long profile enforcement remains in monitor mode before protect mode becomes the default.

**Local profiles:** Decide whether centrally AI-enabled clusters may continue creating local profiles.

**AIWorkload profile identity:** Move the inference profile from a label into the workload spec and determine whether it should be immutable after creation.

**Gateway master key:** Choose between an operator namespace, protected per-endpoint namespace, or external secret store.

**Virtual-key issuance:** Decide whether users obtain inference keys through AI Factory, the SDK, or LiteLLM administration.

**Inference budgets:** Decide whether default budgets and rate limits belong to the profile, project, or both.

**Content guardrails:** Define which guardrails the standard inference blueprints enable by default and whether profiles may strengthen but not weaken them.

## 29. Out of scope

This design does not define:

- workload placement or cluster selection;
- cluster readiness;
- quotas and scheduling;
- KAI or Kueue policy;
- general network/data policy for training workloads.

Inference gateway isolation remains in scope because request-level gateway controls are ineffective if workloads can connect directly to the model server.

## Overall architecture

```text
                         AI FACTORY

                    Platform Administrator
                             │
                             ▼
                       Profile Packs
                  portable + versioned
                             │
                             │ bind
                             ▼
              ┌──────────────────────────┐
              │                          │
          Cluster A                  Cluster B
              │                          │
              ▼                          ▼
       ComputeProfiles             ComputeProfiles
              │                          │
              └────────────┬─────────────┘
                           │
                    Project Entitlement
                           │
                           ▼
                    Allowed Profiles
                           │
                           ▼
                  UI / SDK / Jupyter
                           │
                           ▼
                    AIJob / AIWorkload
                           │
                           ▼
                 Kubernetes Admission
                           │
                           ▼
                       Kubewarden
                           │
                           ▼
              AI Factory Profile Policy
                           │
                 ┌─────────┴─────────┐
                 │                   │
              Accepted            Rejected
                 │                   │
                 ▼                   ▼
          Deploy Workload       Clear reason
                 │
                 ▼
          Record profile
           and version
```

## Core design principles

**1. A profile is an enforceable contract.**

Profiles are not simply templates used by the UI. Every workload is independently checked at Kubernetes admission.

**2. AI Factory defines policy; Kubewarden enforces it.**

AI Factory owns Profile Packs, ComputeProfiles, project entitlement and validation semantics. Kubewarden provides the admission-policy infrastructure and executes the authoritative AI Factory policy.

**3. Define policy once; bind it to each cluster.**

Profile Packs contain portable intent. ComputeProfiles combine that intent with the capabilities and configuration of a particular cluster.

**4. Quotas and profiles solve different problems.**

A quota determines **how much** a project may consume. A profile determines **what shape of workload** it may create.

**5. Client validation improves usability; admission provides authority.**

The UI and SDK catch errors early. Kubewarden makes the final admission decision regardless of how the workload was submitted.

**6. Users customize within an administrator-defined envelope.**

The platform owns fixed values and limits. Users control only explicitly editable fields.

**7. Policy enforcement can be introduced safely.**

Monitor mode provides visibility before protect mode makes profile violations blocking.

**8. The profile and version become part of workload history.**

A completed run records which policy admitted it, making the decision understandable later even if the profile changes.

**9. Training and inference share the same deployment-policy model.**

Both AIJobs and AIWorkloads are validated against profiles. Inference additionally requires gateway and network controls for request-time policy.

The resulting Jupyter experience remains straightforward:

```python
profiles = ai.profiles.list()

run = ai.runs.create(
    profile="pytorch-distributed",
    nodes=3,
    script="train.py",
)
```

The data scientist chooses an approved profile and works within its limits.

Behind the scenes:

**Profile Pack → ComputeProfile → Project Entitlement → Kubewarden → Workload**

AI Factory manages the policy lifecycle; Kubewarden makes that policy authoritative at Kubernetes admission.
