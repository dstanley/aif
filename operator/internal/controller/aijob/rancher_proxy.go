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
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"helm.sh/helm/v3/pkg/cli"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"

	helmClient "github.com/SUSE/aif-operator/internal/infra/helm"
)

// RancherProxy reaches Rancher-managed clusters through Rancher's cluster proxy
// (<rancher>/k8s/clusters/<id>), with the API token in a Secret in the
// operator's namespace:
//
//	url     the Rancher server URL (https://rancher.example.com)
//	token   a Rancher API token, ideally of a user with rights only on the
//	        clusters that run AIJobs
//	ca.crt  optional: the CA that signed Rancher's certificate
//
// Any cluster Rancher manages works the same way: imported, provisioned, or a
// Harvester cluster. Connections are cached and rebuilt when the Secret changes.
type RancherProxy struct {
	// Secrets reads the Secret on this cluster.
	Secrets   ctrl.Reader
	Namespace string
	Secret    string
	Scheme    *runtime.Scheme

	mu    sync.Mutex
	conns map[string]*proxyConn
}

type proxyConn struct {
	key    string
	target *Target
}

const proxyTimeout = 30 * time.Second

// Connect returns the clients for a cluster, checking on a new connection that
// the cluster answers.
func (p *RancherProxy) Connect(ctx context.Context, cluster string) (*Target, error) {
	sec := &corev1.Secret{}
	if err := p.Secrets.Get(ctx, ctrl.ObjectKey{Namespace: p.Namespace, Name: p.Secret}, sec); err != nil {
		return nil, fmt.Errorf("read the remote clusters secret %s/%s: %w", p.Namespace, p.Secret, err)
	}
	url := strings.TrimRight(strings.TrimSpace(string(sec.Data["url"])), "/")
	token := strings.TrimSpace(string(sec.Data["token"]))
	ca := sec.Data["ca.crt"]
	if url == "" || token == "" {
		return nil, fmt.Errorf("the remote clusters secret %s/%s needs url and token", p.Namespace, p.Secret)
	}
	sum := sha256.Sum256([]byte(url + "\x00" + token + "\x00" + string(ca)))
	key := hex.EncodeToString(sum[:])

	p.mu.Lock()
	defer p.mu.Unlock()
	if c := p.conns[cluster]; c != nil && c.key == key {
		return c.target, nil
	}

	host := url + "/k8s/clusters/" + cluster
	cfg := &rest.Config{Host: host, BearerToken: token, Timeout: proxyTimeout}
	caFile := ""
	if len(ca) > 0 {
		cfg.CAData = ca
		// Helm's settings take the CA as a file
		caFile = filepath.Join(os.TempDir(), "aif-rancher-ca-"+key[:16]+".crt")
		if err := os.WriteFile(caFile, ca, 0o600); err != nil {
			return nil, fmt.Errorf("write the Rancher CA: %w", err)
		}
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	if _, err := cs.Discovery().ServerVersion(); err != nil {
		return nil, fmt.Errorf("through Rancher at %s: %w", url, err)
	}
	reader, err := ctrl.New(cfg, ctrl.Options{Scheme: p.Scheme})
	if err != nil {
		return nil, err
	}
	var helms sync.Map
	t := &Target{
		Cluster: cluster,
		Reader:  reader,
		Logs:    clientsetLogs{cs},
		Helm: func(namespace string) (helmClient.HelmClient, error) {
			if c, ok := helms.Load(namespace); ok {
				return c.(helmClient.HelmClient), nil
			}
			s := cli.New()
			s.SetNamespace(namespace)
			s.KubeAPIServer = host
			s.KubeToken = token
			s.KubeCaFile = caFile
			c, err := helmClient.New(s)
			if err != nil {
				return nil, err
			}
			actual, _ := helms.LoadOrStore(namespace, c)
			return actual.(helmClient.HelmClient), nil
		},
	}
	if p.conns == nil {
		p.conns = map[string]*proxyConn{}
	}
	p.conns[cluster] = &proxyConn{key: key, target: t}
	return t, nil
}
