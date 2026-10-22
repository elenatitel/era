{{/* Traefik basic-auth filter for an HTTPRoute rule: include "era-web.authFilter" (dict "enabled" true "name" "<middleware>") */}}
{{- define "era-web.authFilter" -}}
{{- if .enabled }}
      filters:
        - type: ExtensionRef
          extensionRef: {group: traefik.io, kind: Middleware, name: {{ .name }}}
{{- end }}
{{- end -}}
