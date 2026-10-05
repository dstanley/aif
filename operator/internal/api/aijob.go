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

package api

import (
	"net/http"

	aiplatformv1alpha1 "github.com/SUSE/aif-operator/api/v1alpha1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// AIJobHandler lists AIJob records. It answers with the operator's service
// account, not the caller's, so it leaves out spec.values (which can carry
// credentials) and offers no writes: the UI and SDK create, cancel and delete
// AIJobs through the Kubernetes API, where the user's own RBAC applies.
type AIJobHandler struct {
	client client.Client
}

// NewAIJobHandler constructs an AIJobHandler.
func NewAIJobHandler(c client.Client) *AIJobHandler {
	return &AIJobHandler{client: c}
}

// Register wires the handler's routes onto the mux.
func (h *AIJobHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/aijobs", h.listAIJobs)
}

func (h *AIJobHandler) listAIJobs(w http.ResponseWriter, r *http.Request) {
	var list aiplatformv1alpha1.AIJobList
	if err := h.client.List(r.Context(), &list); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	for i := range list.Items {
		list.Items[i].ManagedFields = nil
		list.Items[i].Spec.Values = nil
		// The client strips TypeMeta from list items; restore it so consumers
		// (the UI's YAML view) get a self-describing object.
		list.Items[i].APIVersion = aiplatformv1alpha1.GroupVersion.String()
		list.Items[i].Kind = "AIJob"
	}
	writeJSON(w, http.StatusOK, &list)
}

// Compile-time guard.
var _ Handler = (*AIJobHandler)(nil)
