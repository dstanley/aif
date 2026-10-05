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
	"fmt"
	"slices"

	ctrl "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/SUSE/aif-operator/api/v1alpha1"
	helmClient "github.com/SUSE/aif-operator/internal/infra/helm"
)

// localCluster is the Rancher ID of the cluster the operator runs in.
const localCluster = "local"

// Target is where a job's execution lives: the cluster its release is installed
// in, and the clients that reach it. The AIJob itself always stays where the
// operator runs.
type Target struct {
	// Cluster is the Rancher cluster ID ("local" for this one).
	Cluster string
	// Reader reads the execution objects, uncached.
	Reader ctrl.Reader
	// Helm builds the Helm client for a namespace on that cluster.
	Helm func(namespace string) (helmClient.HelmClient, error)
	// Logs reads pod logs on that cluster, for the run's report.
	Logs PodLogReader
}

// ClusterConnector reaches clusters other than this one.
type ClusterConnector interface {
	// Connect returns the clients for a cluster. An error it cannot recover from
	// by retrying is a permanentError; anything else is retried.
	Connect(ctx context.Context, cluster string) (*Target, error)
}

// unreachableError is a target cluster that could not be reached; the job waits
// and the operator retries.
type unreachableError struct{ error }

// targetCluster is the cluster a job runs on.
func targetCluster(job *v1alpha1.AIJob) string {
	if c := job.Spec.TargetCluster; c != "" && c != localCluster {
		return c
	}
	return localCluster
}

// target resolves a job's cluster. A cluster the operator may not use, or no
// remote support configured, is a permanentError; a connection failure is an
// unreachableError.
func (r *AIJobReconciler) target(ctx context.Context, job *v1alpha1.AIJob) (*Target, error) {
	cluster := targetCluster(job)
	if cluster == localCluster {
		return &Target{Cluster: localCluster, Reader: r.APIReader, Helm: r.helm, Logs: r.PodLogs}, nil
	}
	if !slices.Contains(r.AllowedClusters, cluster) {
		return nil, permanentError{fmt.Errorf("cluster %s is not allowed for AIJobs (operator --aijob-allowed-clusters)", cluster)}
	}
	if r.Clusters == nil {
		return nil, permanentError{fmt.Errorf("cluster %s: this operator is not configured to reach other clusters (operator --aijob-remote-clusters-secret)", cluster)}
	}
	t, err := r.Clusters.Connect(ctx, cluster)
	if err != nil {
		var perm permanentError
		if errors.As(err, &perm) {
			return nil, err
		}
		return nil, unreachableError{fmt.Errorf("cluster %s: %w", cluster, err)}
	}
	return t, nil
}
