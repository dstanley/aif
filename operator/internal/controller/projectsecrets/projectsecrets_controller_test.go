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

package projectsecrets

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

const (
	cluster = "c-m-altra"
	backing = "c-m-altra-p-abcde"
	name    = "suse-ai-pull-combined"
)

func project(id string, ai bool, backingNS string) *unstructured.Unstructured {
	p := &unstructured.Unstructured{}
	p.SetGroupVersionKind(projectGVK)
	p.SetNamespace(cluster)
	p.SetName(id)
	if ai {
		p.SetLabels(map[string]string{ProjectLabel: "true"})
	}
	if backingNS != "" {
		_ = unstructured.SetNestedField(p.Object, backingNS, "status", "backingNamespace")
	}
	return p
}

type harness struct {
	t   *testing.T
	c   client.Client
	r   *Reconciler
	cfg []byte
}

func newHarness(t *testing.T, objs ...client.Object) *harness {
	s := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(s))
	s.AddKnownTypeWithName(projectGVK, &unstructured.Unstructured{})
	s.AddKnownTypeWithName(projectGVK.GroupVersion().WithKind("ProjectList"), &unstructured.UnstructuredList{})
	c := fake.NewClientBuilder().WithScheme(s).WithObjects(objs...).Build()
	h := &harness{t: t, c: c, cfg: []byte(`{"auths":{"dp.apps.rancher.io":{"auth":"dXNlcjp0b2tlbg=="}}}`)}
	h.r = &Reconciler{Client: c, SecretName: name, DockerConfig: func(context.Context) ([]byte, error) { return h.cfg, nil }}
	return h
}

func (h *harness) reconcile(id string) reconcile.Result {
	h.t.Helper()
	res, err := h.r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Namespace: cluster, Name: id}})
	require.NoError(h.t, err)
	return res
}

func (h *harness) secret() (*corev1.Secret, error) {
	s := &corev1.Secret{}
	err := h.c.Get(context.Background(), types.NamespacedName{Namespace: backing, Name: name}, s)
	return s, err
}

func TestAnAIProjectGetsTheCredentialsAsAProjectScopedSecret(t *testing.T) {
	h := newHarness(t, project("p-abcde", true, backing))
	res := h.reconcile("p-abcde")

	s, err := h.secret()
	require.NoError(t, err)
	assert.Equal(t, corev1.SecretTypeDockerConfigJson, s.Type)
	assert.Equal(t, string(h.cfg), string(s.Data[corev1.DockerConfigJsonKey]))
	assert.Equal(t, "p-abcde", s.Labels[ProjectScopedSecretLabel], "Rancher copies it into the project's namespaces")
	assert.Equal(t, managedBy, s.Labels[ManagedByLabel])
	assert.Equal(t, resync, res.RequeueAfter)

	h.cfg = []byte(`{"auths":{"nvcr.io":{"auth":"bmV3"}}}`) // a rotated credential
	h.reconcile("p-abcde")
	s, err = h.secret()
	require.NoError(t, err)
	assert.Equal(t, string(h.cfg), string(s.Data[corev1.DockerConfigJsonKey]))
}

func TestAProjectThatIsNoLongerAnAIProjectLosesTheSecret(t *testing.T) {
	h := newHarness(t, project("p-abcde", true, backing))
	h.reconcile("p-abcde")
	_, err := h.secret()
	require.NoError(t, err)

	p := project("p-abcde", true, "")
	require.NoError(t, h.c.Get(context.Background(), client.ObjectKeyFromObject(p), p))
	p.SetLabels(nil) // the project is no longer an AI project
	require.NoError(t, h.c.Update(context.Background(), p))
	h.reconcile("p-abcde")
	_, err = h.secret()
	assert.True(t, apierrors.IsNotFound(err))
}

func TestOtherProjectsAndOtherSecretsAreLeftAlone(t *testing.T) {
	foreign := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: backing},
		Data:       map[string][]byte{corev1.DockerConfigJsonKey: []byte(`{"auths":{}}`)},
	}
	h := newHarness(t, project("p-abcde", true, backing), foreign)
	_, err := h.r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Namespace: cluster, Name: "p-abcde"}})
	assert.ErrorContains(t, err, "not managed by AI Factory")
	s, _ := h.secret()
	assert.Equal(t, `{"auths":{}}`, string(s.Data[corev1.DockerConfigJsonKey]), "someone else's secret is not overwritten")

	h2 := newHarness(t, project("p-other", false, backing))
	h2.reconcile("p-other")
	_, err = h2.secret()
	assert.True(t, apierrors.IsNotFound(err), "a project nobody marked as an AI project gets nothing")
}

func TestWithoutCredentialsNothingIsHandedOut(t *testing.T) {
	h := newHarness(t, project("p-abcde", true, backing))
	h.reconcile("p-abcde")
	h.cfg = nil // the credentials were removed from Settings
	h.reconcile("p-abcde")
	_, err := h.secret()
	assert.True(t, apierrors.IsNotFound(err), "a stale copy would keep working after removal")
}

func TestAProjectWithoutABackingNamespaceYetIsRetried(t *testing.T) {
	h := newHarness(t, project("p-abcde", true, ""))
	res := h.reconcile("p-abcde")
	assert.Positive(t, res.RequeueAfter)
}

func TestSettingsChangesReachEveryAIProject(t *testing.T) {
	h := newHarness(t, project("p-a", true, "c-m-altra-p-a"), project("p-b", false, "c-m-altra-p-b"), project("p-c", true, "c-m-altra-p-c"))
	reqs := h.r.allAIProjects(context.Background(), nil)
	names := make([]string, 0, len(reqs))
	for _, r := range reqs {
		names = append(names, r.Name)
	}
	assert.ElementsMatch(t, []string{"p-a", "p-c"}, names)
}
