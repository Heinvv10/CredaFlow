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
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels of one component: web | worker | migrate */}}
{{- define "credaflow.selectorLabels" -}}
app.kubernetes.io/name: {{ include "credaflow.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "credaflow.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- define "credaflow.migrateImage" -}}
{{- printf "%s:%s" .Values.migrate.image.repository (default .Chart.AppVersion .Values.migrate.image.tag) -}}
{{- end -}}

{{- define "credaflow.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}{{ include "credaflow.fullname" . }}{{- else -}}default{{- end -}}
{{- end -}}

{{- define "credaflow.uploadsClaim" -}}
{{- default (printf "%s-uploads" (include "credaflow.fullname" .)) .Values.persistence.existingClaim -}}
{{- end -}}

{{/* envFrom: the shared ConfigMap (unless skipped) and every existing Secret. */}}
{{- define "credaflow.envFrom" -}}
{{- if not .secretsOnly }}
- configMapRef:
    name: {{ include "credaflow.fullname" .root }}
{{- end }}
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
  ports:
    {{- range .Values.networkPolicy.egressPorts }}
    - { protocol: TCP, port: {{ . }} }
    {{- end }}
{{- end -}}
