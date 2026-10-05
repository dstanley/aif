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

// Package projectsecrets hands the registry credentials configured in AI Factory's Settings to
// every AI project, on whichever cluster the project is. It writes one combined pull secret into
// the project's backing namespace on the management cluster, labelled as a Rancher project-scoped
// secret; Rancher then copies it into every namespace of the project on its downstream cluster
// and keeps the copies current. The credentials stay in one place, Settings, and a project's
// workloads and jobs pull from SUSE Application Collection, SUSE Registry and NVIDIA NGC with the
// secret name profiles and blueprints already use.
package projectsecrets

import (
	"context"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

const (
	// ProjectLabel marks a Rancher project as an AI project: the AI Factory UI sets it on the
	// projects it creates or enables, and only those projects receive the credentials.
	ProjectLabel = "ai-factory.suse.com/project"
	// ProjectScopedSecretLabel is Rancher's: a secret in a project's backing namespace that carries
	// it, valued with the project's name, is copied into every namespace of that project.
	ProjectScopedSecretLabel = "management.cattle.io/project-scoped-secret"
	// ManagedByLabel marks the secrets this controller owns, so it never touches another one.
	ManagedByLabel = "ai-factory.suse.com/managed-by"
	managedBy      = "project-secrets"

	// resync re-reads the credentials as a backstop to the watches below.
	resync = 10 * time.Minute
)

var projectGVK = schema.GroupVersionKind{Group: "management.cattle.io", Version: "v3", Kind: "Project"}

// DockerConfigFunc builds the combined dockerconfigjson, or nil when no credentials are configured.
type DockerConfigFunc func(ctx context.Context) ([]byte, error)

// Reconciler keeps each AI project's pull secret in step with Settings.
type Reconciler struct {
	client.Client
	// SecretName is the pull secret's name in each namespace (suse-ai-pull-combined).
	SecretName string
	// DockerConfig builds the secret's content from Settings.
	DockerConfig DockerConfigFunc
	// OperatorNamespace holds the credential secrets Settings refers to; a change to one of them
	// (a rotated token) reaches every AI project at once rather than at the next resync.
	OperatorNamespace string
}

// +kubebuilder:rbac:groups=management.cattle.io,resources=projects,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;create;update;patch;delete

func (r *Reconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
	project := &unstructured.Unstructured{}
	project.SetGroupVersionKind(projectGVK)
	if err := r.Get(ctx, req.NamespacedName, project); err != nil {
		if apierrors.IsNotFound(err) {
			return reconcile.Result{}, nil // its backing namespace, and the secret in it, go with it
		}
		return reconcile.Result{}, err
	}
	backing, _, _ := unstructured.NestedString(project.Object, "status", "backingNamespace")
	if backing == "" {
		// Rancher has not created the backing namespace yet.
		return reconcile.Result{RequeueAfter: 30 * time.Second}, nil
	}
	if !isAIProject(project) || project.GetDeletionTimestamp() != nil {
		return reconcile.Result{}, r.remove(ctx, backing)
	}

	cfg, err := r.DockerConfig(ctx)
	if err != nil {
		return reconcile.Result{}, err
	}
	if cfg == nil {
		// No credentials configured: nothing to hand out, and a stale copy would keep working
		// after the credentials were removed from Settings.
		return reconcile.Result{RequeueAfter: resync}, r.remove(ctx, backing)
	}
	return reconcile.Result{RequeueAfter: resync}, r.apply(ctx, backing, project.GetName(), cfg)
}

func isAIProject(p *unstructured.Unstructured) bool {
	return p.GetLabels()[ProjectLabel] == "true"
}

func (r *Reconciler) apply(ctx context.Context, namespace, projectName string, cfg []byte) error {
	secret := &corev1.Secret{}
	err := r.Get(ctx, types.NamespacedName{Namespace: namespace, Name: r.SecretName}, secret)
	switch {
	case apierrors.IsNotFound(err):
		secret = &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: r.SecretName, Namespace: namespace, Labels: labels(projectName)},
			Type:       corev1.SecretTypeDockerConfigJson,
			Data:       map[string][]byte{corev1.DockerConfigJsonKey: cfg},
		}
		return r.Create(ctx, secret)
	case err != nil:
		return err
	case secret.Labels[ManagedByLabel] != managedBy:
		// Someone else's secret by that name: leave it, and say so.
		return fmt.Errorf("secret %s/%s exists and is not managed by AI Factory; not overwriting it", namespace, r.SecretName)
	}
	if string(secret.Data[corev1.DockerConfigJsonKey]) == string(cfg) && secret.Labels[ProjectScopedSecretLabel] == projectName {
		return nil
	}
	for k, v := range labels(projectName) {
		if secret.Labels == nil {
			secret.Labels = map[string]string{}
		}
		secret.Labels[k] = v
	}
	secret.Type = corev1.SecretTypeDockerConfigJson
	secret.Data = map[string][]byte{corev1.DockerConfigJsonKey: cfg}
	return r.Update(ctx, secret)
}

// remove deletes this controller's secret from a backing namespace; Rancher removes the copies.
func (r *Reconciler) remove(ctx context.Context, namespace string) error {
	secret := &corev1.Secret{}
	if err := r.Get(ctx, types.NamespacedName{Namespace: namespace, Name: r.SecretName}, secret); err != nil {
		return client.IgnoreNotFound(err)
	}
	if secret.Labels[ManagedByLabel] != managedBy {
		return nil
	}
	return client.IgnoreNotFound(r.Delete(ctx, secret))
}

func labels(projectName string) map[string]string {
	return map[string]string{ProjectScopedSecretLabel: projectName, ManagedByLabel: managedBy}
}

// SetupWithManager reconciles every Rancher project on a change to it, and every AI project when
// Settings or a credential in the operator's namespace changes.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	project := &unstructured.Unstructured{}
	project.SetGroupVersionKind(projectGVK)
	return ctrl.NewControllerManagedBy(mgr).
		Named("projectsecrets").
		For(project, builder.WithPredicates(predicate.Or(predicate.LabelChangedPredicate{}, predicate.GenerationChangedPredicate{},
			statusBackingNamespaceSet()))).
		Watches(&v1alpha1.Settings{}, handler.EnqueueRequestsFromMapFunc(r.allAIProjects)).
		Watches(&corev1.Secret{}, handler.EnqueueRequestsFromMapFunc(r.allAIProjects), builder.WithPredicates(predicate.NewPredicateFuncs(func(o client.Object) bool {
			return o.GetNamespace() == r.OperatorNamespace
		}))).
		Complete(r)
}

// statusBackingNamespaceSet passes the update in which Rancher records a new project's backing
// namespace, which changes neither its labels nor its generation.
func statusBackingNamespaceSet() predicate.Funcs {
	return predicate.Funcs{UpdateFunc: func(e event.UpdateEvent) bool {
		backing := func(o client.Object) string {
			u, ok := o.(*unstructured.Unstructured)
			if !ok {
				return ""
			}
			s, _, _ := unstructured.NestedString(u.Object, "status", "backingNamespace")
			return s
		}
		return backing(e.ObjectOld) != backing(e.ObjectNew)
	}}
}

func (r *Reconciler) allAIProjects(ctx context.Context, _ client.Object) []reconcile.Request {
	list := &unstructured.UnstructuredList{}
	list.SetGroupVersionKind(projectGVK.GroupVersion().WithKind("ProjectList"))
	if err := r.List(ctx, list, client.MatchingLabels{ProjectLabel: "true"}); err != nil {
		return nil
	}
	out := make([]reconcile.Request, 0, len(list.Items))
	for _, p := range list.Items {
		out = append(out, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: p.GetNamespace(), Name: p.GetName()}})
	}
	return out
}
