/*
Copyright 2025.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package aijob

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/SUSE/aif-operator/api/v1alpha1"
	helmClient "github.com/SUSE/aif-operator/internal/infra/helm"
)

// fakeConnector stands in for Rancher's cluster proxy: one remote cluster with
// its own client, Helm and logs, or an error.
type fakeConnector struct {
	target *Target
	err    error
	calls  int
}

func (f *fakeConnector) Connect(_ context.Context, cluster string) (*Target, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	f.target.Cluster = cluster
	return f.target, nil
}

type remote struct {
	c    client.Client
	helm *fakeHelm
	logs *fakeLogs
	conn *fakeConnector
}

func withRemote(h *harness, allowed ...string) *remote {
	rc := fake.NewClientBuilder().WithScheme(h.r.Scheme).Build()
	rm := &remote{c: rc, helm: newFakeHelm(), logs: &fakeLogs{logs: map[string]string{}}}
	rm.conn = &fakeConnector{target: &Target{
		Reader: rc, Logs: rm.logs,
		Helm: func(string) (helmClient.HelmClient, error) { return rm.helm, nil },
	}}
	h.r.Clusters = rm.conn
	h.r.AllowedClusters = allowed
	return rm
}

func onCluster(c string) func(*v1alpha1.AIJob) {
	return func(j *v1alpha1.AIJob) { j.Spec.TargetCluster = c }
}

func TestARemoteJobRunsOnItsClusterAndReportsFromThere(t *testing.T) {
	h := newHarness(t, aijob("remote-1", onCluster("c-abc")))
	rm := withRemote(h, "c-abc")
	h.reconcile("remote-1")

	assert.Len(t, rm.helm.ensured, 1, "installed on the target cluster")
	assert.Empty(t, h.helm.ensured, "not on this one")
	j := h.get("remote-1")
	assert.Equal(t, "c-abc", j.Status.Cluster)
	assert.Equal(t, metav1.ConditionTrue, condStatus(j, v1alpha1.AIJobConditionTargetReachable))

	// the run finishes on the remote cluster; its pod's log carries the report
	job := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "remote-1", Namespace: ns, UID: "remote-job-uid"}}
	require.NoError(t, rm.c.Create(context.Background(), job))
	p := pod("remote-1-0", 0, corev1.PodSucceeded, 5*time.Minute, i32(0))
	p.Namespace, p.Labels = ns, map[string]string{v1alpha1.AIJobJobIDLabel: "remote-1", "batch.kubernetes.io/job-completion-index": "0"}
	p.OwnerReferences = []metav1.OwnerReference{*metav1.NewControllerRef(job, batchv1.SchemeGroupVersion.WithKind("Job"))}
	require.NoError(t, rm.c.Create(context.Background(), &p))
	rm.logs.logs["remote-1-0"] = `AIF_RESULT {"test":"CPU Inference Test","status":"pass","checks":[{"name":"Model answers","ok":true}]}`
	job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue, LastTransitionTime: metav1.NewTime(t0.Add(time.Hour))}}
	require.NoError(t, rm.c.Status().Update(context.Background(), job))
	h.clock = t0.Add(61 * time.Minute)
	h.reconcile("remote-1")

	j = h.get("remote-1")
	assert.Equal(t, v1alpha1.AIJobPhaseSucceeded, j.Status.Phase)
	require.NotNil(t, j.Status.Report)
	assert.Equal(t, "CPU Inference Test", j.Status.Report.Test)
	assert.Equal(t, 1, rm.logs.reads, "the report is read on the target cluster")
}

func TestAClusterNotAllowedFailsTheJobAndInstallsNothing(t *testing.T) {
	h := newHarness(t, aijob("remote-2", onCluster("c-other")))
	rm := withRemote(h, "c-abc")
	h.reconcile("remote-2")

	j := h.get("remote-2")
	assert.Equal(t, v1alpha1.AIJobPhaseFailed, j.Status.Phase)
	assert.Equal(t, "TargetNotAllowed", j.Status.Result.Reason)
	assert.Contains(t, j.Status.Result.Message, "--aijob-allowed-clusters")
	assert.Empty(t, rm.helm.ensured)
	assert.Empty(t, h.helm.ensured)
	assert.Zero(t, rm.conn.calls, "not even contacted")
}

func TestNoRemoteSupportFailsARemoteJob(t *testing.T) {
	h := newHarness(t, aijob("remote-3", onCluster("c-abc")))
	h.r.AllowedClusters = []string{"c-abc"}
	h.reconcile("remote-3")

	j := h.get("remote-3")
	assert.Equal(t, v1alpha1.AIJobPhaseFailed, j.Status.Phase)
	assert.Contains(t, j.Status.Result.Message, "--aijob-remote-clusters-secret")
}

func TestAnUnreachableClusterLeavesTheJobWaitingThenItRuns(t *testing.T) {
	h := newHarness(t, aijob("remote-4", onCluster("c-abc")))
	rm := withRemote(h, "c-abc")
	rm.conn.err = errors.New("dial tcp: i/o timeout")
	res := h.reconcile("remote-4")

	j := h.get("remote-4")
	assert.Equal(t, v1alpha1.AIJobPhasePending, j.Status.Phase, "not failed for it")
	assert.Equal(t, metav1.ConditionFalse, condStatus(j, v1alpha1.AIJobConditionTargetReachable))
	assert.Positive(t, res.RequeueAfter)
	assert.Empty(t, rm.helm.ensured)

	rm.conn.err = nil
	h.reconcile("remote-4")
	assert.Len(t, rm.helm.ensured, 1)
	assert.Equal(t, metav1.ConditionTrue, condStatus(h.get("remote-4"), v1alpha1.AIJobConditionTargetReachable))
}

func TestDeletingAJobWhoseClusterWasNeverReachedDoesNotHang(t *testing.T) {
	h := newHarness(t, aijob("remote-5", onCluster("c-abc")))
	rm := withRemote(h, "c-abc")
	rm.conn.err = errors.New("dial tcp: i/o timeout")
	h.reconcile("remote-5") // finalizer added, never installed
	require.NoError(t, h.c.Delete(context.Background(), h.get("remote-5")))
	_, err := h.r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "remote-5"}})
	require.NoError(t, err)
	assert.Error(t, h.c.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: "remote-5"}, &v1alpha1.AIJob{}), "gone")
}

func TestALocalJobIgnoresTheRemoteSettings(t *testing.T) {
	h := newHarness(t, aijob("here-1", onCluster("local")))
	rm := withRemote(h, "c-abc")
	h.reconcile("here-1")
	assert.Len(t, h.helm.ensured, 1)
	assert.Empty(t, rm.helm.ensured)
	assert.Zero(t, rm.conn.calls)
	assert.Equal(t, "local", h.get("here-1").Status.Cluster)
}

// The proxy against a stand-in Rancher: the path it calls, the token it sends,
// the connection it caches, and a rotated token.
func TestRancherProxyReachesAClusterThroughRancher(t *testing.T) {
	var paths atomic.Value
	var auth atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths.Store(r.URL.Path)
		auth.Store(r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"major":"1","minor":"34","gitVersion":"v1.34.2+rke2r1"}`))
	}))
	defer srv.Close()

	h := newHarness(t)
	sec := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "aif-remote-clusters", Namespace: "aif-operator"},
		Data: map[string][]byte{"url": []byte(srv.URL + "/"), "token": []byte("token-abc:xyz")}}
	require.NoError(t, h.c.Create(context.Background(), sec))
	p := &RancherProxy{Secrets: h.c, Namespace: "aif-operator", Secret: "aif-remote-clusters", Scheme: h.r.Scheme}

	t1, err := p.Connect(context.Background(), "c-npk9v")
	require.NoError(t, err)
	assert.Equal(t, "c-npk9v", t1.Cluster)
	assert.Equal(t, "/k8s/clusters/c-npk9v/version", paths.Load())
	assert.Equal(t, "Bearer token-abc:xyz", auth.Load())

	t2, err := p.Connect(context.Background(), "c-npk9v")
	require.NoError(t, err)
	assert.Same(t, t1, t2, "cached")

	sec.Data["token"] = []byte("token-new:abc")
	require.NoError(t, h.c.Update(context.Background(), sec))
	t3, err := p.Connect(context.Background(), "c-npk9v")
	require.NoError(t, err)
	assert.NotSame(t, t1, t3, "rebuilt for a rotated token")
	assert.Equal(t, "Bearer token-new:abc", auth.Load())

	sec.Data["token"] = nil
	require.NoError(t, h.c.Update(context.Background(), sec))
	_, err = p.Connect(context.Background(), "c-npk9v")
	assert.ErrorContains(t, err, "needs url and token")
}
