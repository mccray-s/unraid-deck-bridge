# GraphQL API

Bridge extends the official `/graphql` endpoint with `deckBridge` query and mutation namespaces and separate root subscription fields. Use the official API authentication and resource permissions. It does not replace the official `docker` API or provide a separate client authentication scheme.

The complete extension types, inputs, enums, and nullability are in [`contracts/schema.graphql`](../contracts/schema.graphql). The deployed official API's merged schema is authoritative for client code generation; the snapshot contains only Bridge fields. Host support and write restrictions are defined in [`contracts/compatibility.json`](../contracts/compatibility.json).

## Permissions and availability

Namespace access requires an authenticated identity; individual fields require the relevant official permission. Access to a namespace does not grant access to its children.

| Fields | Official resource / action |
|---|---|
| `deckBridge.info` | ME / READ_ANY |
| `docker.config`, `editability`, `templateAdoption`, `localTemplates`, `environment`, `updateAccess`, `updateCheck` | DOCKER / READ_ANY |
| `docker.devices` | OS / READ_ANY |
| `docker.importTemplate`, `prepareInstall`, `install`, `cancelInstall` | DOCKER / CREATE_ANY |
| `docker.prepareEdit`, `prepareTemplateReplacement`, `edit`, `restart`, `prepareImageUpdate`, `updateContainers`, `cancelEdit` | DOCKER / UPDATE_ANY |
| `docker.checkUpdates` (metadata job, not a container change) | DOCKER / READ_ANY |
| `system.status`; `system.prepare`, `shutdown`, `reboot` | OS / READ_ANY; UPDATE_ANY |
| `plugins.installed`; `plugins.prepareUninstall`, `uninstall` | CONFIG / READ_ANY; DELETE_ANY |
| `array.status`; array previews and controls | ARRAY / READ_ANY; UPDATE_ANY |
| `operations.docker/system/plugins/array` and corresponding subscriptions | DOCKER / OS / CONFIG / ARRAY, respectively, with READ_ANY |

All paths in the table except subscriptions are under `deckBridge`. Query and mutation namespaces are distinct. Task reads cannot bypass another domain's permissions. Docker READ_ANY permits access to sanitized Docker tasks created by other users; `byRequestId` lookup is scoped to the current identity. Plans and cancellation are bound to their creating identity.

Read successful capability responses before offering actions. Relevant capabilities include `docker.engineEdit`, `docker.configurationFeedback`, `docker.cancel`, `docker.templateManagementRead`, `docker.templateAdopt`, `docker.templateReplace`, `plugins.uninstall`, `array.parity.read`, and `array.parity.control`. A read capability is not write permission, and schema visibility alone does not prove the host supports an action. `docker.updateAccess` allows Docker-only availability checks without ME permission.

An offline service, permission error, transport failure, or unknown mutation outcome is **not** evidence that a capability is absent. Do not use these failures to trigger an alternate write API. `liveExecutionVerified=false`, where returned, must not be presented as verified live execution.

```graphql
query BridgeInfo {
  deckBridge {
    info { version coreOnline compatible dockerAvailable capabilities reason }
  }
}
```

## Preview, submit, and recover

1. Read the applicable state or draft and collect explicit user intent.
2. Call the corresponding `prepare*` mutation and display its warnings and changes.
3. Send a **separate request** with the returned `planId` and a stable `requestId` after confirmation.
4. Observe the returned task until its authoritative terminal result is available.

Nested sibling mutation fields are not an ordering guarantee. Never combine preview and dependent submission in one request. Previews do not apply the proposed configuration. Drafts and plans expire after ten minutes; drafts also expire when the service restarts. Plans bind the authenticated identity and target state, and are consumed on submission. Stale state requires a fresh preview, not an altered submission.

Submission normally uses `{planId, requestId}`. Docker restart instead uses `{containerId, requestId}`. Request IDs are 8–128 characters. Reusing an ID with the same identity and request content returns the original task; different content yields `IDEMPOTENCY_CONFLICT`.

If the submission response is lost, query the matching domain's `byRequestId` using the **original** request ID. Do not invent a new ID and blindly repeat the change. Idempotent submission is not permission to replay a task whose execution outcome is unknown: reconcile through read-only queries first. `NEEDS_ATTENTION`, timeout, or a dropped connection never proves that nothing changed.

```graphql
mutation PrepareInstall($input: DeckBridgeDockerConfigurationInput!) {
  deckBridge {
    docker {
      prepareInstall(input: $input) {
        id kind expires config changed
        changeSummary { field kind target before after sensitive }
        warnings updateImage
      }
    }
  }
}

mutation SubmitInstall($input: DeckBridgeSubmitInput!) {
  deckBridge { docker { install(input: $input) { id status stage } } }
}

query FindSubmittedTask($requestId: String!) {
  deckBridge {
    operations { docker { byRequestId(requestId: $requestId) { id status stage } } }
  }
}
```

For `SubmitInstall`, variables have the form:

```json
{"input":{"planId":"<id from preview>","requestId":"install-example-0001"}}
```

## Docker configuration and templates

- Read `environment`, `creationDefaults`, and, when authorized, `devices` to build supported choices. Do not hard-code network names or assume arbitrary Docker CLI options are supported.
- `config(containerId)` returns a typed draft. `editability(containerId)` is a read-only eligibility check with `editable`, `source`, `reasonCode`, and `limitations`. Errors must not be converted into an `editable=false` result.
- Use `importTemplate(input)` with explicit `source: URL`, `XML`, or `LOCAL`. URL requires `url`; XML requires `xml`; LOCAL requires `templateId` and `revision`. Required values cannot be blank; unrelated fields must be omitted, null, or empty.
- `localTemplates` returns the full User/Default catalog without pagination, User entries first. Same-name entries remain distinct. A null container-existence result is unknown, not absence. Invalid entries expose `issueCode`; the catalog does not expose XML or source file paths. LOCAL imports revalidate the selected revision.
- `DeckBridgeDockerConfigurationInput` requires `name`, `image`, `network`, `privileged`, `start`, `autoStart`, `ports`, `mounts`, `environment`, and `labels`. See the schema for optional runtime, network, template-field, metadata, and advanced-argument inputs.
- Input collections are complete replacements: leaving an item out removes it. For a sensitive existing environment variable or label, preserve its draft value with `{name, value:"", sensitive:true, keepFieldId}`. To change it, send the new value. Never submit a displayed redaction placeholder as a secret.
- Configuration reads may include ordinary variable and label values. Common credentials and template `Mask=true` fields are redacted; mark custom secrets in the template. Task reads and subscriptions do not return configuration values.
- Display blocking and nonblocking limitations in both editing and confirmation. Missing or unusable template association can leave ordinary editing available without template synchronization; it does not grant adoption eligibility. Compose, Swarm, other external managers, and unsupported container integrations remain ineligible.
- Ordinary edits preserve the container's name and running-state intent. Engine-source editing requires `docker.engineEdit` and does not accept `updateImage=true`. It does not pull or silently substitute a changed local image reference: `IMAGE_REFERENCE_CHANGED` requires explicit update or a new preview.
- Plans report `source`, `sourceAfter`, and nullable `targetContainerId`; clients do not choose `source`, operation `kind`, or an overwrite flag. `plan.updateImage` is the approved image intent, not a client inference.

Missing bind sources appear in `directoriesToCreate`; previews do not create directories. Display this proposed filesystem change before confirmation. Treat unreadable sources (`MOUNT_SOURCE_UNREADABLE`) differently from missing sources (`MOUNT_SOURCE_MISSING`).

`changeSummary` describes ADDED/MODIFIED/REMOVED fields; sensitive entries omit `before` and `after`. `changed` lists actual change categories, not every inherited value. An ordinary preview with no changes, no image update, and no directories to create should disable confirmation (`NO_CONFIGURATION_CHANGES`). Explicit adoption, replacement, and image update remain deliberate actions even with an empty configuration summary.

### Management metadata

`metadata { iconUrl, webUi, shell }` is returned with drafts and plans. Omitting the object or a child, or using null, preserves draft values; without a draft, URLs default to empty and shell to `sh`. An explicit empty URL clears it; empty shell resets to `sh`. Supported written shell choices are `sh` and `bash`; unsupported existing choices require explicit correction rather than silent replacement.

New nonempty `iconUrl` values must be HTTP(S) without embedded credentials. `webUi` also supports Unraid `[IP]` and `[PORT:number]` placeholders. A valid existing local icon reference may be preserved. This API does not upload, host, proxy, or download icons. Metadata changes use the normal preview/edit workflow and can require container recreation; they are not an in-place label patch.

Template import retains valid embedded `TemplateURL` metadata, using the download URL only when it is missing; `sourceUrl` identifies the actual download source. Other template display/source metadata is preserved, not exposed as arbitrary writable configuration.

### Explicit template management

Require `docker.templateManagementRead` for the template-management contract and the appropriate write capability before confirmation. An upgrade requirement must not be bypassed with a legacy write route.

| Intent | Preview/read | Submission |
|---|---|---|
| Adoption eligibility | `templateAdoption(containerId)` | None |
| Adopt during edit | `prepareEdit(containerId, input, updateImage:false, adoptTemplate:true)` | `edit` |
| Reinstall selected same-name User template | `prepareTemplateReplacement(containerId, input)` | `edit` |

Adoption requires an eligible container with a genuinely missing template; a broken, ambiguous, or unreadable template is not permission to overwrite it. Adoption fixes the image/name/running-state intent and does not combine with an image update. Replacement requires the current user's selected LOCAL USER draft and revision, keeps its template name, and explicitly rebuilds the target. Both require UPDATE_ANY, not merely CREATE_ANY. Ordinary installation can return `templateReuse`; obtain confirmation before updating that existing User template.

## Image checks and updates

`checkUpdates(requestId, force:false)` starts or joins the shared full check. `updateCheck(id, offset:0, limit:100)` only reads results; omitted ID selects the current/latest check, null means none, and an expired explicit ID yields `CHECK_EXPIRED`. Offsets are nonnegative and limits are 1–100.

Take the first page's fixed check ID and `eventSequence`, read remaining pages for that same ID, then subscribe after the captured sequence. Compare item revisions only within the same check. `AVAILABLE` and `canUpdate` are separate: both, fresh evidence, and matching container/image identity are required. Registry failures remain UNKNOWN; Compose targets are skipped.

For a single update, call `prepareImageUpdate` with the approved `checkId`, `containerId`, `currentImageId`, and `revision`, then submit through `edit`. For a batch, send a nonempty, duplicate-free approved target list to `updateContainers({requestId, targets})`. Observe its parent task using `operations.docker.imageUpdateBatch(id, offset, limit)` and the batch subscription; `activeOperation` exposes the current child and its pull progress.

`allowMissingTemplate` defaults to false and is **per target**. Only an eligible target explicitly reported as `TEMPLATE_MISSING` may use it, after the user accepts rebuilding from current configuration without restoring the missing template. It does not repair damaged templates or transfer management ownership. Changed evidence invalidates approval.

Updates recreate containers. They do not copy unmounted writable-layer data or guarantee rollback of application data. Old images and backup containers are not substitutes for appdata/volume backups. Closing a page does not cancel an update, and interrupted waiting batch items are not automatically replayed after a service restart.

## Tasks, events, and cancellation

Each domain provides `get(id, after)` and `byRequestId(requestId)` under `deckBridge.operations`. Cross-domain IDs are NOT_FOUND (or null for request lookup). Task statuses are QUEUED, RUNNING, SUCCEEDED, FAILED, NEEDS_ATTENTION, and CANCELLED; power tasks may also be DISPATCHED. A dispatched request is not proof of physical shutdown or application readiness.

```graphql
query DockerTask($id: String!, $after: Int!) {
  deckBridge { operations { docker { get(id: $id, after: $after) {
    id status stage containerId canCancel cancelRequested
    configurationResult startResult
    error { code message issue { field target index } }
    events { sequence time stage code message }
    pullProgress { revision finished layers { id phase current total } }
  } } } }
}

subscription DockerEvents($id: String!, $after: Int!) {
  deckBridgeDockerOperationEvents(id: $id, after: $after) {
    sequence time stage code message
  }
}
```

The other task subscriptions are `deckBridgeSystemOperationEvents`, `deckBridgePluginOperationEvents`, and `deckBridgeArrayOperationEvents`. Image checks and batches use `deckBridgeDockerUpdateCheckEvents` and `deckBridgeDockerImageUpdateBatchEvents`; see the schema for payloads.

Event history is bounded (latest 1,000 events), and is not guaranteed after a service or host restart. Subscriptions end after about 55 seconds; reconnect with the last sequence and renew official authorization. EOF is not task completion. On `CURSOR_EXPIRED`, including a future cursor, rebuild the relevant snapshot/pages instead of skipping missing results. Query the authoritative task result before enabling conflicting changes.

`event.code` is a nullable stable localization identifier, not an error code or stage. Localize recognized codes and otherwise display the safe `message`; do not parse English messages. `pullProgress` is a latest-state snapshot, independent of the event cursor: compare `revision`, preserve unknown byte totals as null, and do not infer success from `finished`. Progress may disappear after restart; never fabricate 100% completion. Configuration/start receipts and task results, not progress text, determine the outcome.

### Configuration and recovery receipts

Ordinary configuration operations (INSTALL, EDIT, ENGINE_EDIT, TEMPLATE_ADOPT, TEMPLATE_REPLACE with `imageUpdate=false`) provide:

- `configurationResult`: NOT_APPLIED, APPLIED, or UNKNOWN.
- `startResult`: NOT_REQUESTED, ACCEPTED, FAILED, or UNKNOWN.

APPLIED means configuration was committed; ACCEPTED means Docker accepted a start request, not that the application became ready or stayed running. Explicit start failure can leave an applied container in place. NOT_APPLIED does not guarantee application-data rollback. These fields are nullable for unrelated task types and older records; never manufacture UNKNOWN for a missing field. Pure image updates have their own result semantics.

NEEDS_ATTENTION requires read-only inspection and user intervention, not automatic mutation replay. Recovery observations are not permission to delete resources or resume work. In `recovery.volumes`, `created` describes planned creation, `exists` is an optional observation, and `owned` can be unknown. Never automatically delete a volume based on `created`. Nullable `engineConfigurationMatches`, `templateMatches`, and `autoStartMatches` are independent observations; unknown is neither false nor success.

### Safe Docker cancellation

Require `docker.cancel`. `cancelInstall(operationId)` applies to the caller's INSTALL; `cancelEdit(operationId)` applies to the caller's EDIT, ENGINE_EDIT, ENGINE_IMAGE_UPDATE, TEMPLATE_ADOPT, TEMPLATE_REPLACE, or IMAGE_UPDATE_BATCH parent. IDs are 32 lowercase hexadecimal characters. Cancellation returns the existing task and does not allocate a new request ID. It requires the corresponding write permission, not an additional READ or ME permission.

`canCancel` describes current eligibility, not authorization. Restart tasks, terminal tasks, direct batch children, and tasks without a live cancellation context cannot be cancelled. Cancellation is supported only before container changes begin. `cancelRequested=true` is intent, not completion: keep observing until the final task result. Safe cancellation ends as CANCELLED with no error; downloaded image data can remain. Repeated cancellation of an owned terminal task returns its unchanged result.

Only batch parents can be cancelled; previously completed updates remain applied. Read the complete final batch pagination, not just the event stream. `cancelled` is separate from failed/skipped; terminal counts satisfy `total = completed = updated + unchanged + failed + skipped + needsAttention + cancelled`. Closing a page never implicitly cancels work. If a cancellation response is lost, recover through read-only queries rather than replaying mutations.

## Host, plugin, and array controls

Host previews return `DeckBridgeHostPlan` and use the same expiry, identity, request-ID, and recovery rules as Docker plans. Conflicting active changes can return BUSY rather than queue a later destructive action.

| Action | Preview | Submit |
|---|---|---|
| Shutdown / reboot | `system.prepare(input:{action:"SHUTDOWN"})` or `"REBOOT"` | `system.shutdown` / `reboot` |
| Plugin removal | `plugins.prepareUninstall(pluginId)` | `plugins.uninstall` |
| Array start / stop | `array.prepare(input:{action:"START"})` or `"STOP"` | `array.start` / `stop` |
| Parity controls | `array.prepareParity(input)` | `startParity` / `pauseParity` / `resumeParity` / `cancelParity` |

Power DISPATCHED only confirms dispatch; a changed boot ID and REBOOT_OBSERVED do not prove a clean shutdown. The same host cannot prove it physically powered off. Unknown results require reconciliation, not another power command.

Plugin removal requires `plugins.uninstall`, not only older preview/execute capabilities. Only supported registered `.plg` plugins with readable manifests are eligible. Bridge itself, Unraid OS, and the official API plugin are protected. Native plugin removal scripts may delete that plugin's configuration, data, or dependencies; no transactional rollback or preservation guarantee is made. A remaining registration or installed manifest can result in NEEDS_ATTENTION even after a successful command exit. Never blindly retry unknown removal outcomes.

```graphql
mutation PreviewPluginRemoval($pluginId: String!) {
  deckBridge { plugins { prepareUninstall(pluginId: $pluginId) {
    id expires summary warnings
  } } }
}

mutation RemovePlugin($input: DeckBridgeSubmitInput!) {
  deckBridge { plugins { uninstall(input: $input) {
    id domain status stage error { code message }
  } } }
}
```

Array controls reject unsupported or uncertain situations, including required unlock input, maintenance mode, missing-disk confirmation, new disks, rebuild, and clear operations. An accepted request is not completion; observe the task's confirmed target state. External WebUI/SSH changes can invalidate previews and cannot be treated as transactionally isolated.

### Parity state

`array.status` includes `bootId`, ISO 8601 `observedAt`, and a current `parity` snapshot. States are IDLE, RUNNING, PAUSED, UNAVAILABLE, or UNKNOWN; kinds are PARITY_CHECK, READ_CHECK, REBUILD, CLEAR, or UNKNOWN. Rebuild includes parity sync and data rebuild. Do not apply parity-check controls to an unknown kind or phase.

`positionBytes`, `totalBytes`, `speedBytesPerSecond`, `elapsedSeconds`, and `errorCount` are nullable decimal strings to preserve precision. Zero is `"0"`; unknown is null, including for `correcting`. Eligibility flags do not replace permissions. Current `elapsedSeconds` is host-reported and may cover only the most recent running segment after resume; do not fill missing time using speed, a client timer, or historical results.

`prepareParity` accepts START, PAUSE, RESUME, or CANCEL. START requires an explicit Boolean `correct`, including false. Other actions must omit `correct`; explicit null is rejected. Confirm the returned plan and submit through the corresponding action field. Previews cannot eliminate every external race or distinguish all successive runs with identical state.

`parity.lastResult` is independent of current progress and may be null when active or uncertain. Its COMPLETED/CANCELLED/FAILED result, timestamps, duration, and error count describe an observed previous outcome, not a substitute for current elapsed time or complete history. Use the official API for full parity history, pool monitoring (`array.caches`), and member disk details (`disk(id:)`); Bridge has no pool topology or history namespace.

## Errors

Use stable error codes and safe messages, not raw server output or message matching. Common codes include CONFLICT, BUSY, PLAN_EXPIRED, PLAN_MISMATCH, IDEMPOTENCY_CONFLICT, UNSUPPORTED_TEMPLATE, UNSUPPORTED_CONTAINER, IMAGE_REFERENCE_CHANGED, RECOVERY_REQUIRED, NOT_CANCELLABLE, and TEMPLATE_MANAGEMENT_UPGRADE_REQUIRED.

Configuration failures can expose `GraphQLError.extensions.deckBridgeIssue`; task failures use typed `error.issue`. Its `field`, optional `target`, and nonnegative `index` identify a public configuration location without containing secret values. Preserve unknown errors for display rather than converting authentication, availability, or protocol failures into an empty result. Never log API credentials or submitted sensitive configuration.
