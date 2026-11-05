# Guest door access

The browser PIN + permanent room QR flow has been replaced by DoorKey mobile
credentials. See [DoorKey Manager](doorkey-manager.md) for the operator flow,
Helm/Argo CD deployment, API contract and required iOS/firmware update.

Old API routes are disabled by default. Existing database rows and encrypted
Home Assistant settings are retained for rollback; the new flow does not use them.
