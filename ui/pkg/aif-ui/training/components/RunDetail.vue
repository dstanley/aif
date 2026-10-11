<script lang="ts">
// The detail under a Workloads row (what the Jobs page used to show). Training: the Job, scheduler
// and queue, Kueue admission, completions, image, a badge per rank linking to its pod, and logs.
// Inference: the blueprint, the endpoint URL, and each pod the blueprint installed, by name, linking
// to its pod page, with its logs. Both: YAML and Delete (handled by the page).
import { defineComponent, PropType } from 'vue';
import BadgeState from '@components/BadgeState/BadgeState.vue';
import VolumeFiles from './VolumeFiles.vue';
import { podRank, primaryPod } from '../pods';
import { podRole, Run } from '../runs';
import type { CheckpointVolume } from '../checkpoints';
import { failureOf, parseResult, reportResult, RunFailure, RunResult } from '../results';
import {
  CHAIN_LABEL, duration, originText, RunTiming, RunWorkflow, shortUri, StepItem, stepsOf, timingOf, workflowOf
} from '../workflow';
import { ago } from '../runs';
import { readPodLog } from '../podlog';
import { describeLatest, isStarting, podEvents } from '../podevents';

export default defineComponent({
  name:       'RunDetail',
  components: { BadgeState, VolumeFiles },
  props:      {
    run:        { type: Object as PropType<Run>, required: true },
    checkpoint: { type: Object as PropType<CheckpointVolume | null>, default: null },
  },
  emits: ['yaml', 'remove', 'copy', 'remove-checkpoint'],

  data() {
    return {
      rankMenu: false, rankMenuStyle: {} as Record<string, string>, result: null as RunResult | null, browsing: false,
      // what each pod that has not started yet is doing: its newest event
      setup:    {} as Record<string, { text: string; warning: boolean }>,
      setupTimer: null as ReturnType<typeof setInterval> | null,
      // the other runs of this run's chain, for the step strip (read when the panel opens)
      chainJobs:  [] as any[],
    };
  },

  computed: {
    t0(): any {
      return this.run.training;
    },

    // Rank 0 prints the run's own output; the others echo it at best.
    logsPod(): any {
      return primaryPod(this.run.pods);
    },
    logsKey(): string {
      return `${ this.logsPod?.metadata?.name || '' }/${ this.logsPod?.status?.phase || '' }/${ this.kept ? 'kept' : '' }`;
    },
    // the pods still being set up (scheduled, pulling, creating); their events say what is happening
    startingPods(): any[] {
      return (this.run.pods || []).filter((p: any) => isStarting(p));
    },
    startingKey(): string {
      return this.startingPods.map((p: any) => p.metadata?.name).join(',');
    },
    // why the run failed or cannot start, from its AIJob: the only record when no pod ever existed
    failure(): RunFailure | null {
      return this.run.type === 'training' ? failureOf(this.run.obj) : null;
    },
    // what submitted the run (a pipeline), its chain and step, and what it consumed and produced
    workflow(): RunWorkflow | null {
      return this.run.type === 'training' ? workflowOf(this.run.obj) : null;
    },
    chainKey(): string {
      return this.workflow?.chain ? `${ this.run.obj?.metadata?.namespace }/${ this.workflow.chain }` : '';
    },
    // the run's path through its chain: the runs it came after, it, and those after it
    steps(): StepItem[] {
      return this.workflow?.chain ? stepsOf(this.run.obj, this.chainJobs) : [];
    },
    timing(): RunTiming | null {
      return this.run.type === 'training' ? timingOf(this.run.obj) : null;
    },
    // the result the run's AIJob kept when it finished; it outlives the pods
    kept(): RunResult | null {
      return reportResult(this.run.obj); // only an AIJob has status.report
    },
  },

  watch: {
    // a test or benchmark run reports its results in its log; read them when the panel opens,
    // and again when the run moves on (its pod finishes)
    logsKey: { immediate: true, handler() { this.loadResult(); } },
    startingKey: { immediate: true, handler(key: string) { this.watchSetup(!!key); } },
    chainKey:    { immediate: true, handler() { this.loadChain(); } },
  },

  beforeUnmount() {
    this.watchSetup(false);
  },

  methods: {
    watchSetup(on: boolean) {
      if (this.setupTimer) {
        clearInterval(this.setupTimer);
        this.setupTimer = null;
      }
      if (!on) {
        this.setup = {};

        return;
      }
      this.loadSetup();
      this.setupTimer = setInterval(() => this.loadSetup(), 5000);
    },

    async loadSetup() {
      const cluster = encodeURIComponent(String(this.$route.params.cluster || 'local'));
      const out: Record<string, { text: string; warning: boolean }> = {};

      await Promise.all(this.startingPods.map(async(p: any) => {
        const ns = encodeURIComponent(p.metadata.namespace);
        const sel = encodeURIComponent(`involvedObject.name=${ p.metadata.name }`);

        try {
          const res = await this.$store.dispatch('cluster/request', { url: `/k8s/clusters/${ cluster }/api/v1/namespaces/${ ns }/events?fieldSelector=${ sel }` });
          const line = describeLatest(podEvents(res?.items || res?.data?.items || []));

          if (line) {
            out[p.metadata.name] = line;
          }
        } catch (e) {
          // events not readable here: the badge alone, as before
        }
      }));
      this.setup = out;
    },

    async loadResult() {
      if (this.kept) {
        this.result = this.kept;

        return;
      }
      const pod = this.logsPod;

      if (this.run.type !== 'training' || !pod || !['Running', 'Succeeded', 'Failed'].includes(pod.status?.phase)) {
        return;
      }
      try {
        const log = await readPodLog(this.$store, String(this.$route.params.cluster || 'local'), pod.metadata.namespace, pod.metadata.name, 'tailLines=400');

        this.result = parseResult(log);
      } catch (e) {
        this.result = null; // no log to read (the pod is gone, or logs are not readable here)
      }
    },

    async loadChain() {
      if (!this.chainKey) {
        this.chainJobs = [];

        return;
      }
      const cluster = encodeURIComponent(String(this.$route.params.cluster || 'local'));
      const ns = encodeURIComponent(this.run.obj.metadata.namespace);
      const sel = encodeURIComponent(`${ CHAIN_LABEL }=${ this.workflow?.chain }`);

      try {
        const res = await this.$store.dispatch('cluster/request', { url: `/k8s/clusters/${ cluster }/apis/ai-factory.suse.com/v1alpha1/namespaces/${ ns }/aijobs?labelSelector=${ sel }` });

        this.chainJobs = res?.items || res?.data?.items || [];
      } catch (e) {
        this.chainJobs = []; // the strip shows the run alone
      }
    },

    ago(iso: string): string {
      return ago(iso);
    },

    duration(s: number | null): string {
      return duration(s);
    },

    stepIcon(phase: string): string {
      return ({
        Succeeded: 'icon-checkmark text-success', Failed: 'icon-x text-error', Cancelled: 'icon-x text-muted', Running: 'icon-spinner icon-spin text-info'
      } as Record<string, string>)[phase] || 'icon-dot-open text-muted';
    },

    podRank(pod: any): string {
      return podRank(pod);
    },

    shortUri(uri: string): string {
      return shortUri(uri);
    },

    originText(o: any): string {
      return originText(o);
    },

    podRole(pod: any): string {
      return podRole(pod);
    },

    podPhase(pod: any): string {
      if (pod?.metadata?.deletionTimestamp) {
        return 'Terminating';
      }
      const waiting = (pod?.status?.containerStatuses || []).find((c: any) => c.state?.waiting)?.state?.waiting?.reason;

      if (waiting && waiting !== 'ContainerCreating') {
        return waiting; // CrashLoopBackOff, ImagePullBackOff: the phase alone says Pending/Running
      }
      const ready = (pod?.status?.containerStatuses || []).every((c: any) => c.ready);

      return pod?.status?.phase === 'Running' && !ready ? 'Starting' : pod?.status?.phase || 'Pending';
    },

    phaseClass(p: string): string {
      return ({
        Running: 'bg-info', Succeeded: 'bg-success', Complete: 'bg-success', Failed: 'bg-error', Pending: 'bg-warning', Starting: 'bg-warning', Terminating: 'bg-disabled'
      } as Record<string, string>)[p] || (/BackOff|Err|Error/.test(p) ? 'bg-error' : 'bg-disabled');
    },

    // Rancher's own log viewer (follows, searches, downloads, switches containers), opened on one pod.
    openLogs(pod: any) {
      this.rankMenu = false;
      pod?.openLogs?.();
    },

    toggleRankMenu(ev: MouseEvent) {
      this.rankMenu = !this.rankMenu;
      if (this.rankMenu) {
        // fixed, from the caret's rect, so the table's container cannot clip it
        const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        const height = 8 + this.run.pods.length * 24;
        const below = window.innerHeight - rect.bottom > height + 8;

        this.rankMenuStyle = { top: `${ below ? rect.bottom + 2 : rect.top - height - 2 }px`, left: `${ rect.right - 96 }px` };
        window.setTimeout(() => document.addEventListener('click', () => {
          this.rankMenu = false;
        }, { once: true }), 0);
      }
    },

    shortImage(image: string): string {
      const trimmed = (image || '').split('@')[0];

      return trimmed.split('/').pop() || trimmed;
    },
  },
});
</script>

<template>
  <div class="tj-detail">
    <section
      v-if="failure"
      :class="['tj-failure', { waiting: failure.waiting }]"
      role="alert"
    >
      <strong><i class="icon icon-warning" /> {{ failure.title }}</strong>
      <span
        v-if="failure.reason"
        class="text-muted"
      >{{ failure.reason }}</span>
      <pre v-if="failure.message">{{ failure.message }}</pre>
    </section>
    <!-- ======== training ======== -->
    <template v-if="run.type === 'training' && t0">
      <div class="tj-facts">
        <div>
          <span class="tj-k">Job</span>
          <router-link
            v-if="t0.job"
            :to="t0.job.detailLocation"
          >
            {{ t0.job.kind || 'Job' }} {{ run.name }}
          </router-link>
          <span
            v-else
            class="text-muted"
            title="The Job was cleaned up after it finished; the Helm release remains"
          >cleaned up</span>
        </div>
        <div>
          <span class="tj-k">Scheduler / queue</span>{{ t0.scheduler }}<span
            v-if="t0.queue"
            class="text-muted"
          > / {{ t0.queue }}</span>
        </div>
        <div>
          <span class="tj-k">Admitted</span>
          <span
            v-if="t0.admitted === true"
            class="text-success"
          >yes</span>
          <span
            v-else-if="t0.admitted === false"
            class="text-warning"
          >waiting</span>
          <span
            v-else
            class="text-muted"
          >—</span>
        </div>
        <div><span class="tj-k">Completions</span>{{ t0.completions }}</div>
        <div v-clean-tooltip="t0.image">
          <span class="tj-k">Image</span>{{ shortImage(t0.image) || '—' }}
        </div>
      </div>
      <!-- part of a workflow: what submitted it, its chain, the steps around it, when it ran -->
      <div
        v-if="workflow"
        class="tj-pods-row"
      >
        <span class="tj-k">Workflow</span>
        <template v-if="workflow.origin">
          {{ originText(workflow.origin) }}<template v-if="workflow.origin.run">
            , run&nbsp;<a
              v-if="workflow.origin.url"
              :href="workflow.origin.url"
              target="_blank"
              rel="noopener noreferrer"
            >{{ workflow.origin.run }}</a>
            <span v-else>{{ workflow.origin.run }}</span>
          </template>
        </template>
        <span
          v-if="workflow.chain"
          class="text-muted"
        >{{ workflow.origin ? '&nbsp;· ' : '' }}chain <code>{{ workflow.chain }}</code></span>
      </div>
      <div
        v-if="steps.length"
        class="tj-pods-row tj-steps"
      >
        <span class="tj-k">Steps</span>
        <template
          v-for="(st, i) in steps"
          :key="st.name"
        >
          <span
            v-if="i"
            class="tj-step-line"
          />
          <span
            :class="['tj-step', { current: st.current }]"
            :title="`${ st.name }: ${ st.phase }`"
          >
            <i :class="['icon', stepIcon(st.phase)]" /> {{ st.step || st.name }}<span
              v-if="st.current && steps.length > 1"
              class="text-muted"
            >&nbsp;({{ i + 1 }}/{{ steps.length }})</span>
          </span>
        </template>
      </div>
      <div
        v-if="timing"
        class="tj-pods-row"
      >
        <span class="tj-k">Started</span>{{ timing.started ? ago(timing.started) : '—' }}
        <span class="tj-k tj-k-next">Completed</span>{{ timing.completed ? ago(timing.completed) : '—' }}
        <span class="tj-k tj-k-next">Duration</span>{{ duration(timing.seconds) }}
      </div>
    </template>

    <!-- ======== inference ======== -->
    <template v-if="run.type === 'inference' && run.inference">
      <div class="tj-facts">
        <div><span class="tj-k">Blueprint</span>{{ run.inference.blueprint }}</div>
        <div><span class="tj-k">Components</span>{{ run.inference.components.join(', ') || '—' }}</div>
        <div v-if="run.url">
          <span class="tj-k">Endpoint</span><code>{{ run.url }}</code>
          <a
            href="#"
            class="tj-copy"
            @click.prevent="$emit('copy', run.url)"
          >Copy</a>
        </div>
      </div>
      <table class="tj-pods">
        <tr v-if="!run.pods.length">
          <td class="text-muted">
            No pods yet: AI Factory is still rolling the blueprint out.
          </td>
        </tr>
        <tr
          v-for="p in run.pods"
          :key="p.id"
        >
          <td>
            <router-link :to="p.detailLocation">
              {{ p.metadata.name }}
            </router-link>
          </td>
          <td class="text-muted">
            {{ podRole(p) }}
          </td>
          <td>
            <BadgeState
              :color="phaseClass(podPhase(p))"
              :label="podPhase(p)"
            />
          </td>
          <td class="text-muted">
            {{ p.spec && p.spec.nodeName }}
          </td>
          <td class="tj-right">
            <button
              class="btn role-tertiary btn-sm"
              @click="openLogs(p)"
            >
              <i class="icon icon-list-flat" /> Logs
            </button>
          </td>
        </tr>
      </table>
    </template>

    <!-- A test or benchmark's own report: the AIF_RESULT line its script prints last. -->
    <section
      v-if="result"
      :class="['tj-result', result.status]"
    >
      <header>
        <strong>{{ result.test || 'Results' }}</strong>
        <span :class="['tj-result-status', result.status]">{{ result.status === 'pass' ? 'Passed' : 'Failed' }}</span>
      </header>
      <ul class="tj-result-checks">
        <li
          v-for="c in result.checks"
          :key="c.name"
        >
          <i :class="['icon', !c.ok ? 'icon-x text-error' : c.warn ? 'icon-warning text-warning' : 'icon-checkmark text-success']" />
          <span class="tj-result-name">{{ c.name }}</span>
          <span class="text-muted">{{ c.detail }}</span>
        </li>
      </ul>
      <dl
        v-if="Object.keys(result.metrics).length || Object.keys(result.env).length"
        class="tj-result-facts"
      >
        <div
          v-for="(v, k) in { ...result.metrics, ...result.env }"
          :key="k"
        >
          <dt>{{ k }}</dt>
          <dd>{{ v }}</dd>
        </div>
      </dl>
    </section>

    <!-- what the run used and produced, then where its outputs are kept, then its pods -->
    <template v-if="run.type === 'training' && t0">
      <section
        v-if="workflow && workflow.artifacts.length"
        class="tj-section"
      >
        <h4>Artifacts</h4>
        <table class="tj-artifacts">
          <tr>
            <th />
            <th>Artifact</th>
            <th>Where</th>
            <th>SHA-256</th>
            <th>From</th>
          </tr>
          <tr
            v-for="a in workflow.artifacts"
            :key="`${ a.direction }-${ a.name }`"
          >
            <td
              class="text-muted"
              :title="a.direction === 'input' ? 'consumed' : 'produced'"
            >
              {{ a.direction === 'input' ? 'in' : 'out' }}
            </td>
            <td>{{ a.name }}</td>
            <td>
              <code
                class="tj-ellipsis"
                :title="a.uri"
              >{{ shortUri(a.uri) }}</code>
            </td>
            <td class="tj-nowrap">
              <template v-if="a.sha256">
                <code :title="a.sha256">{{ a.sha256.slice(0, 12) }}</code>
                <button
                  class="btn role-link btn-sm tj-copy-hash"
                  type="button"
                  title="Copy the SHA-256"
                  aria-label="Copy the SHA-256"
                  @click="$emit('copy', a.sha256)"
                >
                  <i class="icon icon-copy" />
                </button>
              </template>
              <span
                v-else
                class="text-muted"
              >—</span>
            </td>
            <td class="text-muted">
              {{ a.producedBy }}
            </td>
          </tr>
        </table>
      </section>
      <div
        v-if="checkpoint"
        class="tj-pods-row"
      >
        <span class="tj-k">Checkpoint volume</span>
        {{ checkpoint.name }} · {{ checkpoint.size }}<template v-if="checkpoint.storageClass">
          · {{ checkpoint.storageClass }}
        </template>
        <span class="text-muted">&nbsp;· kept after the run</span>
        <button
          class="btn role-tertiary btn-sm tj-copy"
          type="button"
          :disabled="checkpoint.inUseBy.length > 0"
          :title="checkpoint.inUseBy.length ? `In use by ${ checkpoint.inUseBy.join(', ') }: look from that pod instead` : 'List the files on the volume, and download them'"
          :aria-expanded="browsing"
          @click="browsing = !browsing"
        >
          <i :class="['icon', browsing ? 'icon-chevron-up' : 'icon-folder']" /> {{ browsing ? 'Hide files' : 'Browse files' }}
        </button>
        <button
          class="btn role-tertiary btn-sm"
          :disabled="checkpoint.runActive || checkpoint.inUseBy.length > 0 || !!checkpoint.heldBy?.length"
          :title="checkpoint.runActive ? 'The run is still active' : checkpoint.inUseBy.length ? `In use by ${ checkpoint.inUseBy.join(', ') }` : checkpoint.heldBy?.length ? `Kept until the run is cleaned up: ${ checkpoint.heldBy.join(', ') } finished but still names it` : 'Delete the volume and its data'"
          @click="$emit('remove-checkpoint', checkpoint)"
        >
          <i class="icon icon-delete" /> Delete volume
        </button>
      </div>
      <VolumeFiles
        v-if="checkpoint && browsing"
        :checkpoint="checkpoint"
      />
      <div class="tj-pods-row">
        <span class="tj-k">Pods</span>
        <span
          v-if="!run.pods.length"
          class="text-muted"
        >none</span>
        <router-link
          v-for="p in run.pods"
          :key="p.id"
          :to="p.detailLocation"
          class="tj-rank"
          :title="`${ p.metadata.name }: ${ podPhase(p) }`"
        >
          <BadgeState
            :color="phaseClass(podPhase(p))"
            :label="podRank(p)"
          />
        </router-link>
      </div>
      <div
        v-for="p in startingPods"
        v-show="setup[p.metadata.name]"
        :key="`setup-${ p.metadata.name }`"
        :class="['tj-setup', { 'text-warning': setup[p.metadata.name] && setup[p.metadata.name].warning }]"
      >
        <i :class="['icon', setup[p.metadata.name] && setup[p.metadata.name].warning ? 'icon-warning' : 'icon-spinner icon-spin']" />
        <span class="text-muted">{{ podRank(p) }}</span>
        {{ setup[p.metadata.name] && setup[p.metadata.name].text }}
      </div>
    </template>

    <div class="tj-buttons">
      <div
        v-if="run.type === 'training'"
        class="tj-logs"
      >
        <button
          class="btn role-tertiary btn-sm"
          :disabled="!logsPod"
          :title="logsPod ? `Follow the log of ${ logsPod.metadata.name }` : 'No pod to read logs from yet'"
          @click="openLogs(logsPod)"
        >
          <i class="icon icon-list-flat" /> Logs <span
            v-if="run.pods.length > 1"
            class="text-muted"
          >{{ podRank(logsPod) }}</span>
        </button>
        <button
          v-if="run.pods.length > 1"
          class="btn role-tertiary btn-sm tj-caret"
          title="Read a different rank"
          @click.stop="toggleRankMenu($event)"
        >
          <i class="icon icon-chevron-down" />
        </button>
        <div
          v-if="rankMenu"
          class="tj-rank-menu"
          :style="rankMenuStyle"
        >
          <button
            v-for="p in run.pods"
            :key="p.id"
            class="tj-rank-item"
            :title="p.metadata.name"
            @click="openLogs(p)"
          >
            {{ podRank(p) }}
          </button>
        </div>
      </div>
      <button
        class="btn role-tertiary btn-sm"
        title="The live objects (and, for a training run, the Helm values)"
        @click="$emit('yaml', run)"
      >
        <i class="icon icon-file" /> YAML
      </button>
      <button
        class="btn role-tertiary btn-sm"
        @click="$emit('remove', run)"
      >
        <i class="icon icon-delete" /> Delete
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tj-detail { padding: 10px 14px 12px; background: var(--box-bg, var(--body-bg)); border-left: 3px solid var(--primary); display: flex; flex-direction: column; gap: 10px; }
.tj-facts { display: flex; flex-wrap: wrap; gap: 6px 28px; font-size: 13px; code { font-size: 12px; } }
.tj-k { color: var(--muted); margin-right: 8px; }
.tj-copy { margin-left: 8px; font-size: 12px; }
.tj-pods-row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; font-size: 13px; }
.tj-rank { margin-right: 2px; }
.tj-setup { display: flex; align-items: baseline; gap: 6px; font-size: 12px; word-break: break-word; }
.tj-pods { font-size: 13px; td { padding: 3px 18px 3px 0; } }
.tj-right { text-align: right; }
.tj-buttons { display: flex; gap: 6px; align-items: center; }
.tj-logs { display: inline-flex; position: relative;
  .btn:first-child { border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .tj-caret { border-top-left-radius: 0; border-bottom-left-radius: 0; padding: 0 6px; } }
.tj-rank-menu { position: fixed; z-index: 100; min-width: 96px; background: var(--dropdown-bg, var(--body-bg)); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); padding: 3px 0; }
.tj-rank-item { display: block; width: 100%; background: none; border: none; text-align: left; padding: 3px 10px; font-size: 12px; cursor: pointer;
  &:hover { background: var(--dropdown-hover-bg, var(--accent-btn)); } }
.tj-k-next { margin-left: 20px; }
.tj-steps { gap: 6px; }
.tj-step { display: inline-flex; align-items: center; gap: 4px; &.current { font-weight: 600; } }
.tj-step-line { display: inline-block; width: 28px; border-top: 1px solid var(--border); }
.tj-section { border-top: 1px solid var(--border); padding-top: 8px;
  h4 { font-size: 13px; font-weight: 600; margin: 0 0 4px; } }
.tj-artifacts {
  border-collapse: collapse; font-size: 12px; width: 100%;
  th { text-align: left; font-weight: 500; color: var(--muted); padding: 3px 14px 3px 0; border-bottom: 1px solid var(--border); }
  td { padding: 3px 14px 3px 0; vertical-align: middle; border-bottom: 1px dotted var(--border); }
  code { font-size: 11px; }
}
.tj-ellipsis { display: inline-block; max-width: 46ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.tj-nowrap { white-space: nowrap; }
.tj-copy-hash { padding: 0 4px; min-height: 0; line-height: 1; }
.tj-failure {
  border: 1px solid var(--error); border-left-width: 4px; border-radius: 4px; padding: 8px 12px; margin-bottom: 12px;
  &.waiting { border-color: var(--warning); }
  strong { margin-right: 8px; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; font-size: 12px; background: none; padding: 0; }
}
.tj-result {
  border: 1px solid var(--border);
  border-left: 4px solid var(--success);
  border-radius: var(--border-radius);
  padding: 10px 14px;
  &.fail { border-left-color: var(--error); }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
}
.tj-result-status {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; padding: 1px 9px; border-radius: 999px;
  background: #2f9e5b; color: #fff;
  &.fail { background: #d64545; }
}
.tj-result-checks { list-style: none; margin: 0 0 8px; padding: 0; li { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; } }
.tj-result-name { font-weight: 500; }
.tj-result-facts {
  display: grid; grid-template-columns: minmax(140px, max-content) 1fr; margin: 0; max-width: 560px;
  div { display: contents; }
  dt, dd { padding: 2px 16px 2px 0; border-bottom: 1px dotted var(--border); }
  dt { color: var(--muted); }
  dd { margin: 0; font-weight: 500; }
}
</style>
