{{- define "credaflow.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "credaflow.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "credaflow.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "credaflow.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ include "credaflow.tag" . | replace ":" "-" | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels of one component: web | worker | migrate */}}
{{- define "credaflow.selectorLabels" -}}
app.kubernetes.io/name: {{ include "credaflow.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* The release tag or digest. Empty and "latest" are refused: a rollout must be reproducible. */}}
{{- define "credaflow.tag" -}}
{{- $tag := required "image.tag is required: set a release tag, git SHA or digest" .Values.image.tag -}}
{{- if eq $tag "latest" -}}{{- fail "image.tag must not be \"latest\": pin a release tag, git SHA or digest" -}}{{- end -}}
{{- $tag -}}
{{- end -}}

{{- define "credaflow.imageRef" -}}
{{- if hasPrefix "sha256:" .tag -}}{{ .repository }}@{{ .tag }}{{- else -}}{{ .repository }}:{{ .tag }}{{- end -}}
{{- end -}}

{{- define "credaflow.image" -}}
{{- include "credaflow.imageRef" (dict "repository" .Values.image.repository "tag" (include "credaflow.tag" .)) -}}
{{- end -}}

{{/* The migrator image defaults to the runner's tag: they are built together. */}}
{{- define "credaflow.migrateImage" -}}
{{- include "credaflow.imageRef" (dict "repository" .Values.migrate.image.repository "tag" (default (include "credaflow.tag" .) .Values.migrate.image.tag)) -}}
{{- end -}}

{{- define "credaflow.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}{{ include "credaflow.fullname" . }}{{- else -}}default{{- end -}}
{{- end -}}

{{- define "credaflow.uploadsClaim" -}}
{{- default (printf "%s-uploads" (include "credaflow.fullname" .)) .Values.persistence.existingClaim -}}
{{- end -}}

{{/* envFrom: the shared ConfigMap and every existing Secret. */}}
{{- define "credaflow.envFrom" -}}
- configMapRef:
    name: {{ include "credaflow.fullname" .root }}
{{- range .root.Values.existingSecrets }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- end -}}

{{/* Hardened pod and container security contexts shared by web and worker. */}}
{{- define "credaflow.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1001
runAsGroup: 1001
fsGroup: 1001
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "credaflow.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/* Writable paths a read-only root filesystem still needs. */}}
{{- define "credaflow.runtimeVolumeMounts" -}}
- { name: tmp, mountPath: /tmp }
- { name: home, mountPath: /home/nextjs }
- { name: next-cache, mountPath: /app/.next/cache }
- { name: shm, mountPath: /dev/shm }
- { name: uploads, mountPath: /app/uploads }
{{- end -}}

{{- define "credaflow.runtimeVolumes" -}}
- name: tmp
  emptyDir: { sizeLimit: 1Gi }
- name: home
  emptyDir: { sizeLimit: 512Mi }
- name: next-cache
  emptyDir: { sizeLimit: 1Gi }
# Chromium (PDF rendering) needs more than the 64 MB default /dev/shm.
- name: shm
  emptyDir: { medium: Memory, sizeLimit: 512Mi }
- name: uploads
{{- if .Values.persistence.enabled }}
  persistentVolumeClaim:
    claimName: {{ include "credaflow.uploadsClaim" . }}
{{- else }}
  emptyDir: {}
{{- end }}
{{- end -}}

{{/* The tier's container, parameterised by component (web | worker). */}}
{{- define "credaflow.appContainer" -}}
- name: {{ .component }}
  image: {{ include "credaflow.image" .root }}
  imagePullPolicy: {{ .root.Values.image.pullPolicy }}
  ports:
    - { name: http, containerPort: 3300 }
  envFrom:
    {{- include "credaflow.envFrom" . | nindent 4 }}
  env:
    - { name: PORT, value: "3300" }
    - { name: HOSTNAME, value: "0.0.0.0" }
    - { name: APP_MODE, value: {{ .appMode | quote }} }
    - { name: CRON_SCHEDULER, value: {{ .cronScheduler | quote }} }
    - { name: OTEL_SERVICE_NAME, value: {{ printf "credaflow-%s" .component | quote }} }
    {{- with .root.Values.observability.otlpEndpoint }}
    - { name: OTEL_EXPORTER_OTLP_ENDPOINT, value: {{ . | quote }} }
    {{- end }}
    {{- range $name, $value := .root.Values.observability.extraEnv }}
    - { name: {{ $name }}, value: {{ $value | quote }} }
    {{- end }}
    {{- range $name, $value := .extraEnv }}
    - { name: {{ $name }}, value: {{ $value | quote }} }
    {{- end }}
  # Probes on /api/health/live and /ready: public, a bare status. /ready checks only the
  # database; /api/health (storage round trip, cron freshness) is for humans and monitors.
  startupProbe:
    httpGet: { path: /api/health/ready, port: http }
    periodSeconds: 5
    failureThreshold: 36
  readinessProbe:
    httpGet: { path: /api/health/ready, port: http }
    periodSeconds: 10
    timeoutSeconds: 5
    failureThreshold: 3
  livenessProbe:
    httpGet: { path: /api/health/live, port: http }
    periodSeconds: 15
    timeoutSeconds: 5
    failureThreshold: 4
  {{- with .preStopSleepSeconds }}
  lifecycle:
    preStop:
      exec:
        command: ["sleep", {{ . | quote }}]
  {{- end }}
  resources:
    {{- toYaml .resources | nindent 4 }}
  securityContext:
    {{- include "credaflow.containerSecurityContext" .root | nindent 4 }}
  volumeMounts:
    {{- include "credaflow.runtimeVolumeMounts" .root | nindent 4 }}
{{- end -}}

{{- define "credaflow.egressRules" -}}
- to:
    - namespaceSelector: {}
      podSelector:
        matchLabels:
          k8s-app: kube-dns
  ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }
- to:
    {{- toYaml .Values.networkPolicy.databaseTo | nindent 4 }}
  ports:
    - { protocol: TCP, port: {{ .Values.networkPolicy.databasePort }} }
- to:
    - ipBlock:
        cidr: 0.0.0.0/0
        {{- with .Values.networkPolicy.egressExcept }}
        except:
          {{- toYaml . | nindent 10 }}
        {{- end }}
  ports:
    {{- range .Values.networkPolicy.egressPorts }}
    - { protocol: TCP, port: {{ . }} }
    {{- end }}
{{- if .Values.observability.otlpEndpoint }}
- to:
    {{- toYaml .Values.networkPolicy.otlpTo | nindent 4 }}
  ports:
    - { protocol: TCP, port: {{ .Values.networkPolicy.otlpPort }} }
{{- end }}
{{- with .Values.networkPolicy.egressExtra }}
{{ toYaml . }}
{{- end }}
{{- end -}}
