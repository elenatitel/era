{{/* Names */}}
{{- define "era.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "era.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels for one component: include "era.selector" (list . "api") */}}
{{- define "era.selector" -}}
{{- $ctx := index . 0 -}}
app.kubernetes.io/name: {{ $ctx.Chart.Name }}
app.kubernetes.io/instance: {{ $ctx.Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{- define "era.secretName" -}}
{{- default (printf "%s-secrets" (include "era.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "era.dbHost" -}}
{{- if .Values.postgres.enabled -}}
{{- printf "%s-postgres" (include "era.fullname" .) -}}
{{- else -}}
{{- required "database.host is required (or set postgres.enabled=true for staging)" .Values.database.host -}}
{{- end -}}
{{- end -}}

{{- define "era.image" -}}
{{- $img := index . 0 -}}
{{- $ctx := index . 1 -}}
{{- printf "%s:%s" $img.repository (default $ctx.Chart.AppVersion $img.tag) -}}
{{- end -}}

{{/* Waits for PostgreSQL to accept connections; runs in the api image (Node.js, no extra tools). */}}
{{- define "era.waitForDb" -}}
node -e "const net=require('net');const t=Date.now();(function f(){const s=net.connect({{ .port }},'{{ .host }}');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>{if(Date.now()-t>180000){console.error('database not reachable');process.exit(1)}setTimeout(f,2000)})})()"
{{- end -}}
