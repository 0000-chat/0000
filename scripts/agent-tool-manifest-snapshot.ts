// Portable bridge MCP snapshot generated from 0000 Chat scripts/agent-tool-mcp-manifest.snapshot.json.
// Regenerate with: bun scripts/generate-agent-tool-manifest-snapshot.ts /home/ubuntu/0000-chat --write
// Do not edit by hand; run --check before bridge releases.

export const AGENT_TOOL_MANIFEST_SNAPSHOT = ({
  "AGENT_TOOL_CAPABILITY_PACK_ORDER": [
    "core",
    "threads",
    "runtime",
    "databases",
    "apps",
    "automations",
    "actions",
    "artifacts",
    "admin",
    "spaces"
  ],
  "AGENT_TOOL_CAPABILITY_PACKS": {
    "actions": {
      "approvalBehavior": "Draft writes and action runs may require approval; code inputs are sensitive.",
      "contexts": [
        "action",
        "settings"
      ],
      "defaultVisibility": "contextual",
      "description": "Reusable generated Actions drafts, reads/searches, updates, and gated runtime execution.",
      "effectTypes": [
        "read",
        "schema_write",
        "row_write"
      ],
      "name": "actions",
      "title": "Actions",
      "toolNames": [
        "secrets.listAvailable",
        "actions.createDraft",
        "actions.updateDraft",
        "actions.archive",
        "actions.search",
        "actions.read",
        "tools.executeCode",
        "actions.run"
      ],
      "whenNotToUse": "Do not use generic artifacts for runnable code when a first-class Action is intended.",
      "whenToUse": "Use for reusable generated code/actions, action metadata, and gated action execution."
    },
    "admin": {
      "approvalBehavior": "Admin/security writes are approval-gated; secret writes redact values and default approval changes are an explicit trust boundary.",
      "contexts": [
        "settings"
      ],
      "defaultVisibility": "contextual",
      "description": "Settings, secrets, mailbox-capable agents, trust-boundary approval defaults, and security-adjacent operations.",
      "effectTypes": [
        "admin_write",
        "read",
        "secret_write"
      ],
      "name": "admin",
      "title": "Admin and security",
      "toolNames": [
        "settings.setDefaultApprovalLevel",
        "agents.list",
        "secrets.put"
      ],
      "whenNotToUse": "Do not expose by default and do not change trust/security settings unless the user explicitly asks.",
      "whenToUse": "Use for explicit settings, secrets, agent directory, or approval-mode administration."
    },
    "apps": {
      "approvalBehavior": "App/revision/generation writes may require approval; React publish, disable, and rollback cross an explicit approval boundary; validation/list/read are direct.",
      "contexts": [
        "app",
        "space"
      ],
      "defaultVisibility": "contextual",
      "description": "Prompt-backed OpenUI apps plus checked React code app authoring, revisions, publishing, rollback, and archives.",
      "effectTypes": [
        "read",
        "schema_write",
        "interaction_write",
        "admin_write"
      ],
      "name": "apps",
      "title": "Apps",
      "toolNames": [
        "apps.list",
        "apps.get",
        "apps.create",
        "apps.createRevision",
        "apps.generateFromRevision",
        "apps.listGenerations",
        "apps.update",
        "apps.archive",
        "apps.validateOpenUi",
        "apps.code.describeRuntime",
        "apps.code.create",
        "apps.code.startEdit",
        "apps.code.listFiles",
        "apps.code.readFiles",
        "apps.code.reserveSource",
        "apps.code.completeSource",
        "apps.code.putFiles",
        "apps.code.checkProject",
        "apps.code.readCheck",
        "apps.code.publishRevision",
        "apps.code.discardEdit",
        "apps.code.disable",
        "apps.code.rollback"
      ],
      "whenNotToUse": "Do not create standalone HTML/local files; React code source stays in bounded remote authoring transport; do not use apps.update for prompt-backed creation or revision work.",
      "whenToUse": "Use when the user asks to create, improve, refresh, inspect, or archive a 0000 app/dashboard."
    },
    "artifacts": {
      "approvalBehavior": "Artifact create/update/link/upload completion writes may require approval; reads are direct.",
      "contexts": [
        "thread",
        "space"
      ],
      "defaultVisibility": "deferred",
      "description": "Durable documents/files/reports, R2 upload versions, text edits, reads, and links.",
      "effectTypes": [
        "schema_write",
        "read"
      ],
      "name": "artifacts",
      "title": "Artifacts",
      "toolNames": [
        "artifacts.create",
        "artifacts.createUploadIntent",
        "artifacts.completeUpload",
        "artifacts.search",
        "artifacts.read",
        "artifacts.readContent",
        "artifacts.getContentUrl",
        "artifacts.update",
        "artifacts.patchText",
        "artifacts.link"
      ],
      "whenNotToUse": "Do not confuse low-level upload/version tools with normal app-building; use apps.* for 0000 apps and actions.* for runnable Actions.",
      "whenToUse": "Use when durable markdown, JSON, reports, exports, or generated files should live in 0000 Chat instead of local files."
    },
    "automations": {
      "approvalBehavior": "Automation writes/runs may require approval, especially outside full-permissions threads.",
      "contexts": [
        "automation",
        "space"
      ],
      "defaultVisibility": "contextual",
      "description": "Scheduled, loop, and trigger-like agent automation management and run inspection.",
      "effectTypes": [
        "read",
        "schema_write"
      ],
      "name": "automations",
      "title": "Automations",
      "toolNames": [
        "automations.list",
        "automations.get",
        "automations.create",
        "automations.update",
        "automations.disable",
        "automations.runNow"
      ],
      "whenNotToUse": "Do not create recurring/loop automations without explicit cadence, target space, and approval expectations.",
      "whenToUse": "Use when the user asks to schedule, remind, run later, repeat work, create a loop, or inspect automation history."
    },
    "core": {
      "approvalBehavior": "Read-only except userPrompts.requestChoice, which writes an in-thread decision request.",
      "contexts": [
        "thread"
      ],
      "defaultVisibility": "default",
      "description": "Small always-visible orientation and safe current-thread continuity surface.",
      "effectTypes": [
        "read",
        "interaction_write"
      ],
      "name": "core",
      "title": "Core context and continuity",
      "toolNames": [
        "capabilities.describe",
        "capabilities.advise",
        "context.get",
        "userPrompts.requestChoice",
        "objects.get",
        "objects.search",
        "objects.listLinked",
        "threads.current",
        "threads.read"
      ],
      "whenNotToUse": "Do not add broad CRUD tools here; load contextual packs for app, database, automation, runtime, artifact, or admin work.",
      "whenToUse": "Use at the start of an in-app run, for elliptical follow-ups, typed references, and structured user choices."
    },
    "databases": {
      "approvalBehavior": "Table/field/view writes and row writes may require approval; reads are direct.",
      "contexts": [
        "database",
        "space"
      ],
      "defaultVisibility": "contextual",
      "description": "Dynamic database schema, views, row reads/searches, and row writes.",
      "effectTypes": [
        "read",
        "schema_write",
        "row_write"
      ],
      "name": "databases",
      "title": "Dynamic databases",
      "toolNames": [
        "databases.list",
        "databases.get",
        "databases.listFieldOptions",
        "databases.create",
        "databases.createField",
        "databases.deleteField",
        "databases.listRows",
        "databases.getRow",
        "databases.searchRows",
        "databases.createRow",
        "databases.updateRow",
        "databases.deleteRow",
        "databases.listRelationshipDefinitions",
        "databases.listRowRelationships",
        "databases.createRelationshipDefinition",
        "databases.deleteRelationshipDefinition",
        "databases.createRelationship",
        "databases.deleteRelationship",
        "databases.delete",
        "databaseViews.list",
        "databaseViews.get",
        "databaseViews.getDefault",
        "databaseViews.create",
        "databaseViews.updateConfig",
        "databaseViews.rename",
        "databaseViews.duplicate",
        "databaseViews.setDefault",
        "databaseViews.delete"
      ],
      "whenNotToUse": "Do not create duplicate tables before inspecting existing tables; do not store one-off ephemeral facts as rows.",
      "whenToUse": "Use for structured reusable records, app inputs, searchable datasets, or database-backed workflows."
    },
    "runtime": {
      "approvalBehavior": "Reads are direct; bridge/device controls and notification registrations may require approval.",
      "contexts": [
        "settings"
      ],
      "defaultVisibility": "contextual",
      "description": "Bridge/device runtime, pairing, lifecycle control, and notification runtime state.",
      "effectTypes": [
        "read",
        "admin_write"
      ],
      "name": "runtime",
      "title": "Runtime and bridge operations",
      "toolNames": [
        "runtime.readEvidence",
        "bridgeDevices.list",
        "machineEnrollments.listActive",
        "machineEnrollments.create",
        "machineEnrollments.regenerate",
        "bridgeDevices.revoke",
        "bridgeDevices.delete",
        "bridgeDevices.renameLocation",
        "bridgeDevices.refreshHermesProfiles",
        "bridgeDevices.requestUpdateWhenIdle",
        "bridgeDevices.requestRestartWhenIdle",
        "bridgeDevices.cancelPendingControl",
        "notifications.getBrowserConfig",
        "notifications.getBrowserSubscriptionStatus",
        "notifications.getNativeDeviceStatus",
        "notifications.subscribeBrowser",
        "notifications.registerNativeDevice",
        "notifications.unregisterNativeDevice",
        "notifications.unsubscribeBrowser"
      ],
      "whenNotToUse": "Do not expose by default for normal app-building; do not restart/update devices without explicit user intent.",
      "whenToUse": "Use for local bridge health, pairing, Hermes profile refresh, device control, or notification runtime setup."
    },
    "spaces": {
      "approvalBehavior": "Space writes may require approval; reads are direct.",
      "contexts": [
        "space"
      ],
      "defaultVisibility": "contextual",
      "description": "Space listing, inspection, creation, settings updates, archival, and restoration.",
      "effectTypes": [
        "read",
        "schema_write"
      ],
      "name": "spaces",
      "title": "Spaces",
      "toolNames": [
        "spaces.list",
        "spaces.get",
        "spaces.create",
        "spaces.update",
        "spaces.archive",
        "spaces.unarchive"
      ],
      "whenNotToUse": "Do not archive or mutate spaces unless the user clearly asks for that app-level change.",
      "whenToUse": "Use when the user asks about this space, another space, space settings, or space lifecycle."
    },
    "threads": {
      "approvalBehavior": "Reads are direct; thread creation/forking/tag writes may require approval.",
      "contexts": [
        "thread"
      ],
      "defaultVisibility": "contextual",
      "description": "Thread discovery, durable activity, cached-message search, forking, tags, and agent handoffs.",
      "effectTypes": [
        "read",
        "interaction_write",
        "schema_write"
      ],
      "name": "threads",
      "title": "Threads and conversation work",
      "toolNames": [
        "threads.readActivity",
        "threads.contextList",
        "threads.contextDescribe",
        "threads.contextExpand",
        "threads.list",
        "threads.update",
        "threads.create",
        "threads.createChild",
        "threads.listChildren",
        "threads.listDescendants",
        "threads.listChildrenByTags",
        "threads.continue",
        "threads.fork",
        "messages.search",
        "tags.list",
        "tags.create",
        "tags.update",
        "tags.archive",
        "tags.listForTarget",
        "tags.assign",
        "tags.unassign",
        "agents.sendMailboxMessage",
        "secrets.requestCollection"
      ],
      "whenNotToUse": "Do not use messages.search for current-thread continuity; use context.get, threads.current, and threads.read first.",
      "whenToUse": "Use when the user asks to inspect, create, fork, search, tag, or coordinate work across threads."
    }
  },
  "AGENT_TOOL_MANIFEST": {
    "actions.archive": {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "actions",
      "description": "Archive a reusable generated action so it no longer appears in the default Actions page/search and cannot be run.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "actionId": {
          "kind": "string"
        }
      },
      "risk": "destructive",
      "surfaces": [
        "action",
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "actions.createDraft": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "actions",
      "description": "Create a reusable generated action draft and first version.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "code": {
          "kind": "string",
          "sensitive": true
        },
        "description": {
          "kind": "string"
        },
        "kind": {
          "kind": "enum",
          "values": [
            "agent_action",
            "app_action",
            "automation"
          ]
        },
        "manifest": {
          "kind": "record",
          "value": {
            "kind": "unknown"
          }
        },
        "name": {
          "kind": "string"
        },
        "slug": {
          "kind": "string",
          "optional": true
        },
        "spaceId": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "sensitiveInput": true,
      "surfaces": [
        "action",
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "actions.read": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "actions",
      "description": "Read one reusable generated action and its current version.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "actionId": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "action",
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "actions.run": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "actions",
      "description": "Run one reusable generated action with JSON input through the 0000 Actions runtime.",
      "effect": "row_write",
      "executionMode": "mutation",
      "featureFlagKey": "actions-runtime",
      "inputSchema": {
        "actionId": {
          "kind": "string"
        },
        "input": {
          "kind": "record",
          "value": {
            "kind": "unknown"
          }
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "action",
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "actions.search": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "actions",
      "description": "Search reusable generated actions in the current organization.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "query": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "action",
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "actions.updateDraft": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "actions",
      "description": "Update a reusable generated action draft by creating a new draft version.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "actionId": {
          "kind": "string"
        },
        "code": {
          "kind": "string",
          "sensitive": true
        },
        "description": {
          "kind": "string"
        },
        "kind": {
          "kind": "enum",
          "values": [
            "agent_action",
            "app_action",
            "automation"
          ]
        },
        "manifest": {
          "kind": "record",
          "value": {
            "kind": "unknown"
          }
        },
        "name": {
          "kind": "string"
        },
        "slug": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "sensitiveInput": true,
      "surfaces": [
        "action",
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "agents.list": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "admin",
      "description": "List mailbox-capable agents in the current organization so you can address agent-to-agent handoffs by id or slug.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "limit": {
          "kind": "number",
          "optional": true
        },
        "query": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "agents.sendMailboxMessage": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "threads",
      "description": "Send a mailbox message from the current agent to another agent in the same organization. Use responsePolicy='fire-and-forget' for one-off handoffs, 'reply-allowed' when the recipient may answer, and 'reply-requested' when a reply is desired. Replies must pass parentMailboxMessageId and stay within maxHops; this records the handoff but does not automatically start another ACP session.",
      "effect": "interaction_write",
      "executionMode": "mutation",
      "inputSchema": {
        "body": {
          "kind": "string"
        },
        "maxHops": {
          "kind": "number",
          "optional": true
        },
        "parentMailboxMessageId": {
          "kind": "string",
          "optional": true
        },
        "responsePolicy": {
          "kind": "enum",
          "optional": true,
          "values": [
            "fire-and-forget",
            "reply-allowed",
            "reply-requested"
          ]
        },
        "subject": {
          "kind": "string"
        },
        "toAgentIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "user_interaction",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "apps.archive": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "apps",
      "description": "Archive a saved 0000 app.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "appIdOrSlug": {
          "kind": "string"
        },
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.code.checkProject": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "apps",
      "description": "Run the isolated React code project check and return the exact candidate and diagnostic receipt.",
      "effect": "read",
      "executionMode": "mutation",
      "featureFlagKey": "react-code-apps",
      "inputSchema": {
        "appId": {
          "kind": "string"
        },
        "capabilityManifest": {
          "kind": "unknown"
        },
        "editSessionId": {
          "kind": "string"
        },
        "operationId": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.code.completeSource": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "apps",
      "description": "Complete a previously uploaded bounded React code source blob and return its exact receipt.",
      "effect": "interaction_write",
      "executionMode": "mutation",
      "featureFlagKey": "react-code-apps",
      "inputSchema": {
        "appId": {
          "kind": "string"
        },
        "editSessionId": {
          "kind": "string"
        },
        "operationId": {
          "kind": "string"
        },
        "sourceBlobId": {
          "kind": "string",
          "sensitive": true
        }
      },
      "risk": "user_interaction",
      "sensitiveInput": true,
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.code.create": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "apps",
      "description": "Create or resume creation of an inert React code app in one explicit space. Reuse the same operationId after transport loss, then pass the returned appId to apps.code.startEdit.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "apps",
        "requiredExplicitInputFields": [
          "spaceIdOrSlug"
        ]
      },
      "featureFlagKey": "react-code-apps",
      "inputSchema": {
        "operationId": {
          "kind": "string"
        },
        "spaceIdOrSlug": {
          "kind": "string"
        },
        "title": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.code.describeRuntime": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "apps",
      "description": "Read the React code app runtime contract and bounded authoring limits before starting an edit.",
      "effect": "read",
      "executionMode": "read",
      "featureFlagKey": "react-code-apps",
      "inputSchema": {},
      "risk": "read",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.code.disable": {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "explicit_trust_boundary",
      "capabilityPack": "apps",
      "description": "Disable an owned React code app at the explicit user trust boundary. Reuse the same operationId after transport loss.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "featureFlagKey": "react-code-apps",
      "inputSchema": {
        "appId": {
          "kind": "string"
        },
        "operationId": {
          "kind": "string"
        }
      },
      "risk": "destructive",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.code.discardEdit": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "apps",
      "description": "Discard one inert React code edit. Reuse the same operationId after transport loss.",
      "effect": "interaction_write",
      "executionMode": "mutation",
      "featureFlagKey": "react-code-apps",
      "inputSchema": {
        "appId": {
          "kind": "string"
        },
        "editSessionId": {
          "kind": "string"
        },
        "operationId": {
          "kind": "string"
        }
      },
      "risk": "user_interaction",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.code.listFiles": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "apps",
      "description": "List metadata for the files in one owned React code app edit without returning source bytes.",
      "effect": "read",
      "executionMode": "read",
      "featureFlagKey": "react-code-apps",
      "inputSchema": {
        "appId": {
          "kind": "string"
        },
        "editSessionId": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.code.publishRevision": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "explicit_trust_boundary",
      "capabilityPack": "apps",
      "description": "Publish only the exact successfully checked React code candidate. Do not claim success until the publish receipt returns.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "featureFlagKey": "react-code-apps",
      "inputSchema": {
        "appId": {
          "kind": "string"
        },
        "candidateHash": {
          "kind": "string"
        },
        "capabilityManifestHash": {
          "kind": "string"
        },
        "checkId": {
          "kind": "string"
        },
        "editSessionId": {
          "kind": "string"
        },
        "operationId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.code.putFiles": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "apps",
      "description": "Replace a bounded batch of React code app draft files using completed source blobs. Reuse the same operationId after transport loss.",
      "effect": "interaction_write",
      "executionMode": "mutation",
      "featureFlagKey": "react-code-apps",
      "inputSchema": {
        "appId": {
          "kind": "string"
        },
        "editSessionId": {
          "kind": "string"
        },
        "expectedProjectVersion": {
          "kind": "number"
        },
        "files": {
          "items": {
            "fields": {
              "logicalPath": {
                "kind": "string"
              },
              "sourceBlobId": {
                "kind": "string"
              }
            },
            "kind": "object"
          },
          "kind": "array",
          "sensitive": true
        },
        "operationId": {
          "kind": "string"
        }
      },
      "risk": "user_interaction",
      "sensitiveInput": true,
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.code.readCheck": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "apps",
      "description": "Read bounded diagnostics and status for one exact React code project check.",
      "effect": "read",
      "executionMode": "read",
      "featureFlagKey": "react-code-apps",
      "inputSchema": {
        "appId": {
          "kind": "string"
        },
        "checkId": {
          "kind": "string"
        },
        "editSessionId": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.code.readFiles": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "apps",
      "description": "Read at most ten explicit React code app source files through the bounded remote authoring transport. Never rely on local files.",
      "effect": "read",
      "executionMode": "mutation",
      "featureFlagKey": "react-code-apps",
      "inputSchema": {
        "appId": {
          "kind": "string"
        },
        "editSessionId": {
          "kind": "string"
        },
        "paths": {
          "items": {
            "kind": "string"
          },
          "kind": "array",
          "sensitive": true
        }
      },
      "risk": "read",
      "sensitiveInput": true,
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.code.reserveSource": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "apps",
      "description": "Reserve bounded private source storage for one React code app file. ACP and hosted agents may provide exactly one bounded sourceText or sourceBase64 payload; the transport computes byteLength and sha256, uploads privately, and completes the source receipt. Reuse the same operationId and completionOperationId after transport loss.",
      "effect": "interaction_write",
      "executionMode": "mutation",
      "featureFlagKey": "react-code-apps",
      "inputSchema": {
        "appId": {
          "kind": "string"
        },
        "byteLength": {
          "kind": "number",
          "optional": true,
          "sensitive": true
        },
        "completionOperationId": {
          "kind": "string",
          "optional": true
        },
        "editSessionId": {
          "kind": "string"
        },
        "operationId": {
          "kind": "string"
        },
        "sha256": {
          "kind": "string",
          "optional": true,
          "sensitive": true
        },
        "sourceBase64": {
          "kind": "string",
          "optional": true,
          "sensitive": true
        },
        "sourceText": {
          "kind": "string",
          "optional": true,
          "sensitive": true
        }
      },
      "risk": "user_interaction",
      "sensitiveInput": true,
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.code.rollback": {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "explicit_trust_boundary",
      "capabilityPack": "apps",
      "description": "Roll back an owned React code app to its prior sealed revision at the explicit user trust boundary. Reuse the same operationId after transport loss.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "featureFlagKey": "react-code-apps",
      "inputSchema": {
        "appId": {
          "kind": "string"
        },
        "operationId": {
          "kind": "string"
        }
      },
      "risk": "destructive",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.code.startEdit": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "apps",
      "description": "Create or resume an inert React code app edit. Reuse the same operationId after transport loss.",
      "effect": "interaction_write",
      "executionMode": "mutation",
      "featureFlagKey": "react-code-apps",
      "inputSchema": {
        "appId": {
          "kind": "string"
        },
        "operationId": {
          "kind": "string"
        }
      },
      "risk": "user_interaction",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.create": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "apps",
      "description": "Create a saved prompt-backed 0000 app for a space with an initial app revision. For prompt-backed OpenUI apps, generate, validate, and save the first OpenUI output with apps.generateFromRevision so it appears in the app. Raw OpenUI must begin with root = AppCanvas(...), not AppCanvas { ... } or JSX. Supported OpenUI app components: AppCanvas, Section, MetricRow, Metric, Sparkline, BarChart, WorkloadPanel, WorkloadBar, SignalPanel, Signal, Timeline, TimelineItem, FocusList, FocusItem, DataTable, Badge, Alert, Progress, Card, EmptyState, Disclosure, Tabs, Tab, AvatarLabel, ItemList, Item. Exact signatures: AppCanvas(title, summary, generatedAtDate, sections); Section(title, description, layout, children) where layout is \"single\" or \"split\"; MetricRow(metrics); Metric(label, value, delta, detail, tone, sparkline) where tone is \"calm\", \"good\", \"risk\", or \"urgent\"; Sparkline(values, tone?); BarChart(title, description, labels, values, tone?) where labels is a string array with 1-12 entries, values is a matching array of non-negative numbers, and tone is \"calm\", \"good\", \"risk\", or \"urgent\"; WorkloadPanel(title, description, bars); WorkloadBar(label, value, count, tone) where value is a 0-100 number; SignalPanel(title, signals); Signal(label, summary, tone); Timeline(title, items); TimelineItem(time, title, detail, tone); FocusList(title, items); FocusItem(title, owner, due, priority) where priority is \"high\", \"medium\", or \"low\"; DataTable(title, columns, rows, caption?) where columns is a string array up to 8 values and rows is a string[][] up to 25 rows and 8 cells per row; Badge(label, tone) where tone is \"calm\", \"good\", \"risk\", or \"urgent\"; Alert(title, detail, tone) where tone is \"calm\", \"good\", \"risk\", or \"urgent\"; Progress(label, value, detail?, tone?) where value is a 0-100 number and tone is \"calm\", \"good\", \"risk\", or \"urgent\"; Card(title, description, children) where children may contain only Badge, Progress, Alert, ItemList, DataTable, EmptyState, or AvatarLabel; EmptyState(title, description, actionLabel?) where actionLabel is decorative only and does not perform an action; Disclosure(title, summary, children) where children may contain only Badge, Progress, Alert, ItemList, DataTable, EmptyState, or AvatarLabel; Tabs(tabs) where tabs is an array of Tab entries and is display-only; Tab(label, children) where children may contain only Badge, Progress, Alert, ItemList, DataTable, EmptyState, or AvatarLabel; AvatarLabel(name, subtitle?, tone?) where tone is \"calm\", \"good\", \"risk\", or \"urgent\"; ItemList(title, items); Item(title, description, meta?, tone?) where tone is \"calm\", \"good\", \"risk\", or \"urgent\". Do not use LiveRecord or LiveView unless the active organization has the real-time-apps feature flag; when access is unknown, use static OpenUI components. Use this valid shape as the model for generated openuiRaw: root = AppCanvas(\"Agent work health\", \"A generated operating read for this space.\", \"2026-06-14\", [overview, operations, charts, next])\n\noverview = Section(\"Current shape\", \"The most important static sample metrics.\", \"single\", [metrics])\nmetrics = MetricRow([m1, m2, m3, m4])\nm1 = Metric(\"Revenue\", \"$128.4K\", \"+12%\", \"Monthly recurring revenue is trending upward.\", \"good\", s1)\nm2 = Metric(\"Users\", \"24.1K\", \"+5.3%\", \"Active users increased across the sample period.\", \"good\", s2)\nm3 = Metric(\"Conversion\", \"3.2%\", \"-0.1%\", \"Conversion is nearly flat and worth watching.\", \"risk\", s3)\nm4 = Metric(\"Uptime\", \"99.99%\", \"stable\", \"Service reliability is inside target.\", \"calm\", s4)\ns1 = Sparkline([82, 84, 86, 90, 94, 99], \"good\")\ns2 = Sparkline([19, 20, 21, 22, 23, 24], \"good\")\ns3 = Sparkline([4, 3.8, 3.5, 3.4, 3.3, 3.2], \"risk\")\ns4 = Sparkline([99.9, 99.95, 99.98, 99.99], \"calm\")\n\noperations = Section(\"Operating signals\", \"Capacity and health signals for the sample app.\", \"split\", [workload, signals])\nworkload = WorkloadPanel(\"Team utilization\", \"Static sample allocation by team.\", [w1, w2, w3])\nw1 = WorkloadBar(\"Engineering\", 85, \"85%\", \"risk\")\nw2 = WorkloadBar(\"Design\", 62, \"62%\", \"calm\")\nw3 = WorkloadBar(\"Marketing\", 44, \"44%\", \"good\")\nsignals = SignalPanel(\"Service health\", [sig1, sig2, sig3])\nsig1 = Signal(\"API\", \"Operational\", \"good\")\nsig2 = Signal(\"CDN\", \"Degraded\", \"risk\")\nsig3 = Signal(\"Search\", \"Down\", \"urgent\")\n\ncharts = Section(\"Growth\", \"A bounded categorical comparison.\", \"single\", [revenue])\nrevenue = BarChart(\"Quarterly revenue\", \"USD in thousands\", [\"Q1\", \"Q2\", \"Q3\", \"Q4\"], [82, 96, 104, 128], \"good\")\n\nnext = Section(\"Next actions\", \"Static sample activity, priorities, and phase-one surfaces.\", \"split\", [timeline, focus, card, table])\ntimeline = Timeline(\"Recent activity\", [t1, t2])\nt1 = TimelineItem(\"2 hours ago\", \"Deployment shipped\", \"Version 2.14 reached production.\", \"good\")\nt2 = TimelineItem(\"5 hours ago\", \"Incident resolved\", \"Search timeout mitigation completed.\", \"risk\")\nfocus = FocusList(\"Priority items\", [f1, f2])\nf1 = FocusItem(\"Fix search indexing pipeline\", \"Alex\", \"Today\", \"high\")\nf2 = FocusItem(\"Finalize roadmap review\", \"Sam\", \"Tomorrow\", \"medium\")\ncard = Card(\"Launch readiness\", \"Static shadcn-inspired display primitives.\", [badge, progress, alert, people, empty])\nbadge = Badge(\"On track\", \"good\")\nprogress = Progress(\"Checklist\", 72, \"Five of seven checks are complete.\", \"good\")\nalert = Alert(\"Watch search\", \"Index latency needs one more verification pass.\", \"risk\")\npeople = ItemList(\"Owners\", [owner1, owner2])\nowner1 = Item(\"Engineering\", \"Pipeline mitigation and rollout checks.\", \"Alex\", \"good\")\nowner2 = Item(\"Product\", \"Customer note and launch criteria.\", \"Sam\", \"calm\")\nempty = EmptyState(\"No blockers\", \"No critical unresolved blockers are currently listed.\", \"Add blocker\")\ntable = DataTable(\"Readiness matrix\", [\"Area\", \"Status\"], [[\"API\", \"Ready\"], [\"Search\", \"Watching\"]], \"Static sample rows\"). Do not create HTML files, folders, standalone apps, or local artifacts for app requests; native app types such as markdown decks are still saved 0000 apps, not local files.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "apps",
        "requiredExplicitInputFields": [
          "spaceIdOrSlug"
        ]
      },
      "inputSchema": {
        "designBrief": {
          "kind": "string",
          "optional": true
        },
        "openuiRaw": {
          "kind": "string",
          "optional": true
        },
        "prompt": {
          "kind": "string",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string"
        },
        "title": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.createRevision": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "apps",
      "description": "Create a new immutable prompt/design revision for an existing saved 0000 app. Do not create HTML files or local artifacts as app revisions.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "appIdOrSlug": {
          "kind": "string"
        },
        "designBrief": {
          "kind": "string",
          "optional": true
        },
        "prompt": {
          "kind": "string"
        },
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "title": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.generateFromRevision": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "apps",
      "description": "Save generated output for an existing prompt-backed 0000 app revision, preserving generation history. This tool currently saves OpenUI output; use only these exact OpenUI component signatures: AppCanvas(title, summary, generatedAtDate, sections); Section(title, description, layout, children) where layout is \"single\" or \"split\"; MetricRow(metrics); Metric(label, value, delta, detail, tone, sparkline) where tone is \"calm\", \"good\", \"risk\", or \"urgent\"; Sparkline(values, tone?); BarChart(title, description, labels, values, tone?) where labels is a string array with 1-12 entries, values is a matching array of non-negative numbers, and tone is \"calm\", \"good\", \"risk\", or \"urgent\"; WorkloadPanel(title, description, bars); WorkloadBar(label, value, count, tone) where value is a 0-100 number; SignalPanel(title, signals); Signal(label, summary, tone); Timeline(title, items); TimelineItem(time, title, detail, tone); FocusList(title, items); FocusItem(title, owner, due, priority) where priority is \"high\", \"medium\", or \"low\"; DataTable(title, columns, rows, caption?) where columns is a string array up to 8 values and rows is a string[][] up to 25 rows and 8 cells per row; Badge(label, tone) where tone is \"calm\", \"good\", \"risk\", or \"urgent\"; Alert(title, detail, tone) where tone is \"calm\", \"good\", \"risk\", or \"urgent\"; Progress(label, value, detail?, tone?) where value is a 0-100 number and tone is \"calm\", \"good\", \"risk\", or \"urgent\"; Card(title, description, children) where children may contain only Badge, Progress, Alert, ItemList, DataTable, EmptyState, or AvatarLabel; EmptyState(title, description, actionLabel?) where actionLabel is decorative only and does not perform an action; Disclosure(title, summary, children) where children may contain only Badge, Progress, Alert, ItemList, DataTable, EmptyState, or AvatarLabel; Tabs(tabs) where tabs is an array of Tab entries and is display-only; Tab(label, children) where children may contain only Badge, Progress, Alert, ItemList, DataTable, EmptyState, or AvatarLabel; AvatarLabel(name, subtitle?, tone?) where tone is \"calm\", \"good\", \"risk\", or \"urgent\"; ItemList(title, items); Item(title, description, meta?, tone?) where tone is \"calm\", \"good\", \"risk\", or \"urgent\". Do not use LiveRecord or LiveView unless the active organization has the real-time-apps feature flag; when access is unknown, use static OpenUI components. Do not create HTML files or folders for generated app output.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "appIdOrSlug": {
          "kind": "string"
        },
        "automationRunId": {
          "kind": "string",
          "optional": true
        },
        "dataSnapshotSummary": {
          "kind": "string",
          "optional": true
        },
        "openuiRaw": {
          "kind": "string"
        },
        "revisionId": {
          "kind": "string",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.get": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "apps",
      "description": "Read one saved 0000 app by id or slug, including its type-specific metadata and generated output when available.",
      "effect": "read",
      "executionMode": "read",
      "externalAccess": {
        "capabilityPack": "apps",
        "requiredExplicitInputFields": [
          "appIdOrSlug"
        ]
      },
      "inputSchema": {
        "appIdOrSlug": {
          "kind": "string"
        },
        "includeArchived": {
          "kind": "boolean",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.list": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "apps",
      "description": "List saved 0000 apps for a space, including OpenUI apps, markdown decks, and future app types.",
      "effect": "read",
      "executionMode": "read",
      "externalAccess": {
        "capabilityPack": "apps",
        "requiredExplicitInputFields": [
          "spaceIdOrSlug"
        ]
      },
      "inputSchema": {
        "includeArchived": {
          "kind": "boolean",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.listGenerations": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "apps",
      "description": "List generated outputs for a saved prompt-backed 0000 app.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "appIdOrSlug": {
          "kind": "string"
        },
        "limit": {
          "kind": "number",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.update": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "apps",
      "description": "Legacy update for a saved 0000 app title or raw generated output. Do not use for prompt-backed app creation or edits; prefer apps.createRevision for prompt changes and apps.generateFromRevision for generated OpenUI output. Do not create HTML files or local artifacts.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "apps",
        "requiredExplicitInputFields": [
          "appIdOrSlug"
        ]
      },
      "inputSchema": {
        "appIdOrSlug": {
          "kind": "string"
        },
        "openuiRaw": {
          "kind": "string",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "title": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "apps.validateOpenUi": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "apps",
      "description": "Use this to validate raw OpenUI app language before saving it. The input must begin with root = AppCanvas(...), not AppCanvas { ... } or JSX. Supported app components: AppCanvas, Section, MetricRow, Metric, Sparkline, BarChart, WorkloadPanel, WorkloadBar, SignalPanel, Signal, Timeline, TimelineItem, FocusList, FocusItem, DataTable, Badge, Alert, Progress, Card, EmptyState, Disclosure, Tabs, Tab, AvatarLabel, ItemList, Item. Exact signatures: AppCanvas(title, summary, generatedAtDate, sections); Section(title, description, layout, children) where layout is \"single\" or \"split\"; MetricRow(metrics); Metric(label, value, delta, detail, tone, sparkline) where tone is \"calm\", \"good\", \"risk\", or \"urgent\"; Sparkline(values, tone?); BarChart(title, description, labels, values, tone?) where labels is a string array with 1-12 entries, values is a matching array of non-negative numbers, and tone is \"calm\", \"good\", \"risk\", or \"urgent\"; WorkloadPanel(title, description, bars); WorkloadBar(label, value, count, tone) where value is a 0-100 number; SignalPanel(title, signals); Signal(label, summary, tone); Timeline(title, items); TimelineItem(time, title, detail, tone); FocusList(title, items); FocusItem(title, owner, due, priority) where priority is \"high\", \"medium\", or \"low\"; DataTable(title, columns, rows, caption?) where columns is a string array up to 8 values and rows is a string[][] up to 25 rows and 8 cells per row; Badge(label, tone) where tone is \"calm\", \"good\", \"risk\", or \"urgent\"; Alert(title, detail, tone) where tone is \"calm\", \"good\", \"risk\", or \"urgent\"; Progress(label, value, detail?, tone?) where value is a 0-100 number and tone is \"calm\", \"good\", \"risk\", or \"urgent\"; Card(title, description, children) where children may contain only Badge, Progress, Alert, ItemList, DataTable, EmptyState, or AvatarLabel; EmptyState(title, description, actionLabel?) where actionLabel is decorative only and does not perform an action; Disclosure(title, summary, children) where children may contain only Badge, Progress, Alert, ItemList, DataTable, EmptyState, or AvatarLabel; Tabs(tabs) where tabs is an array of Tab entries and is display-only; Tab(label, children) where children may contain only Badge, Progress, Alert, ItemList, DataTable, EmptyState, or AvatarLabel; AvatarLabel(name, subtitle?, tone?) where tone is \"calm\", \"good\", \"risk\", or \"urgent\"; ItemList(title, items); Item(title, description, meta?, tone?) where tone is \"calm\", \"good\", \"risk\", or \"urgent\". Do not use LiveRecord or LiveView unless the active organization has the real-time-apps feature flag; when access is unknown, use static OpenUI components.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "openuiRaw": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "app",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "artifacts.completeUpload": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "artifacts",
      "description": "Use after artifacts.createUploadIntent and a successful R2 upload to mark the pending artifact version as available.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "featureFlagKey": "artifacts",
      "inputSchema": {
        "artifactId": {
          "kind": "string"
        },
        "byteLength": {
          "kind": "number"
        },
        "contentHash": {
          "kind": "string"
        },
        "versionId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "thread",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "artifacts.create": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "artifacts",
      "description": "Create a small durable org-visible artifact inline. Use this for markdown notes, plans, JSON, and other durable content that should live in 0000 Chat instead of local files. Actions/actions remain first-class; use action tools for runnable code.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "artifacts"
      },
      "featureFlagKey": "artifacts",
      "inputSchema": {
        "content": {
          "kind": "string"
        },
        "contentHash": {
          "kind": "string",
          "optional": true
        },
        "format": {
          "kind": "enum",
          "values": [
            "text/markdown",
            "text/typescript",
            "application/json",
            "binary"
          ]
        },
        "kind": {
          "kind": "enum",
          "values": [
            "document",
            "action",
            "app",
            "file",
            "report"
          ]
        },
        "metadata": {
          "kind": "record",
          "optional": true,
          "value": {
            "kind": "unknown"
          }
        },
        "slug": {
          "kind": "string",
          "optional": true
        },
        "spaceId": {
          "kind": "string",
          "optional": true
        },
        "summary": {
          "kind": "string",
          "optional": true
        },
        "tags": {
          "items": {
            "kind": "string"
          },
          "kind": "array",
          "optional": true
        },
        "title": {
          "kind": "string"
        },
        "versionMetadata": {
          "kind": "record",
          "optional": true,
          "value": {
            "kind": "unknown"
          }
        },
        "visibility": {
          "kind": "enum",
          "optional": true,
          "values": [
            "organization",
            "space",
            "restricted"
          ]
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "thread",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "artifacts.createUploadIntent": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "artifacts",
      "description": "Create an R2 upload intent for a large durable artifact. Upload the content to the returned uploadUrl, then call artifacts.completeUpload with the byte length and content hash.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "featureFlagKey": "artifacts",
      "inputSchema": {
        "extension": {
          "kind": "string",
          "optional": true
        },
        "format": {
          "kind": "enum",
          "values": [
            "text/markdown",
            "text/typescript",
            "application/json",
            "binary"
          ]
        },
        "kind": {
          "kind": "enum",
          "values": [
            "document",
            "action",
            "app",
            "file",
            "report"
          ]
        },
        "metadata": {
          "kind": "record",
          "optional": true,
          "value": {
            "kind": "unknown"
          }
        },
        "slug": {
          "kind": "string",
          "optional": true
        },
        "spaceId": {
          "kind": "string",
          "optional": true
        },
        "summary": {
          "kind": "string",
          "optional": true
        },
        "tags": {
          "items": {
            "kind": "string"
          },
          "kind": "array",
          "optional": true
        },
        "title": {
          "kind": "string"
        },
        "versionMetadata": {
          "kind": "record",
          "optional": true,
          "value": {
            "kind": "unknown"
          }
        },
        "visibility": {
          "kind": "enum",
          "optional": true,
          "values": [
            "organization",
            "space",
            "restricted"
          ]
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "thread",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "artifacts.getContentUrl": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "artifacts",
      "description": "Get a short-lived read URL for an R2-backed artifact version. Use artifacts.read first when you need metadata or the current version id.",
      "effect": "read",
      "executionMode": "read",
      "featureFlagKey": "artifacts",
      "inputSchema": {
        "artifactId": {
          "kind": "string",
          "optional": true
        },
        "expiresIn": {
          "kind": "number",
          "optional": true
        },
        "slug": {
          "kind": "string",
          "optional": true
        },
        "versionId": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "thread",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "artifacts.link": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "artifacts",
      "description": "Use when an artifact should be attached to a first-class 0000 object such as a thread, message, space, database row, action, or app.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "featureFlagKey": "artifacts",
      "inputSchema": {
        "artifactId": {
          "kind": "string"
        },
        "fieldKey": {
          "kind": "string",
          "optional": true
        },
        "relationship": {
          "kind": "enum",
          "values": [
            "source",
            "reference",
            "result",
            "embedded",
            "mentioned"
          ]
        },
        "rowId": {
          "kind": "string",
          "optional": true
        },
        "tableId": {
          "kind": "string",
          "optional": true
        },
        "targetId": {
          "kind": "string"
        },
        "targetType": {
          "kind": "enum",
          "values": [
            "thread",
            "message",
            "space",
            "database_row",
            "database_table",
            "action",
            "app"
          ]
        },
        "targetVersionId": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "thread",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "artifacts.patchText": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "artifacts",
      "description": "Patch an inline markdown/text artifact by replacing exact oldText with newText in a new version. Read with artifacts.readContent first and pass expectedVersionId; if oldText appears more than once, provide more context or set replaceAll true.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "artifacts",
        "requiredExplicitInputFields": [
          "artifactId"
        ]
      },
      "featureFlagKey": "artifacts",
      "inputSchema": {
        "artifactId": {
          "kind": "string",
          "optional": true
        },
        "contentHash": {
          "kind": "string",
          "optional": true
        },
        "expectedContentHash": {
          "kind": "string",
          "optional": true
        },
        "expectedVersionId": {
          "kind": "string"
        },
        "newText": {
          "kind": "string"
        },
        "oldText": {
          "kind": "string"
        },
        "replaceAll": {
          "kind": "boolean",
          "optional": true
        },
        "slug": {
          "kind": "string",
          "optional": true
        },
        "summary": {
          "kind": "string",
          "optional": true
        },
        "tags": {
          "items": {
            "kind": "string"
          },
          "kind": "array",
          "optional": true
        },
        "title": {
          "kind": "string",
          "optional": true
        },
        "versionMetadata": {
          "kind": "record",
          "optional": true,
          "value": {
            "kind": "unknown"
          }
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "thread",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "artifacts.read": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "artifacts",
      "description": "Read artifact metadata and current version metadata by id or slug. Use artifacts.readContent for inline markdown/text content and artifacts.getContentUrl for R2-backed bytes.",
      "effect": "read",
      "executionMode": "read",
      "externalAccess": {
        "capabilityPack": "artifacts",
        "requiredExplicitInputFields": [
          "artifactId"
        ]
      },
      "featureFlagKey": "artifacts",
      "inputSchema": {
        "artifactId": {
          "kind": "string",
          "optional": true
        },
        "slug": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "thread",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "artifacts.readContent": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "artifacts",
      "description": "Read inline markdown/text artifact content directly by id or slug. Use this before editing artifacts like local markdown files; returns content, versionId, contentHash, format, and artifact metadata. R2-backed or binary content is rejected.",
      "effect": "read",
      "executionMode": "read",
      "externalAccess": {
        "capabilityPack": "artifacts",
        "requiredExplicitInputFields": [
          "artifactId"
        ]
      },
      "featureFlagKey": "artifacts",
      "inputSchema": {
        "artifactId": {
          "kind": "string",
          "optional": true
        },
        "slug": {
          "kind": "string",
          "optional": true
        },
        "versionId": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "thread",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "artifacts.search": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "artifacts",
      "description": "Search durable artifacts in the current organization. Use this before creating local files when looking for existing plans, reports, exported files, or generated content.",
      "effect": "read",
      "executionMode": "read",
      "externalAccess": {
        "capabilityPack": "artifacts"
      },
      "featureFlagKey": "artifacts",
      "inputSchema": {
        "kind": {
          "kind": "enum",
          "optional": true,
          "values": [
            "document",
            "action",
            "app",
            "file",
            "report"
          ]
        },
        "limit": {
          "kind": "number",
          "optional": true
        },
        "query": {
          "kind": "string",
          "optional": true
        },
        "spaceId": {
          "kind": "string",
          "optional": true
        },
        "status": {
          "kind": "enum",
          "optional": true,
          "values": [
            "draft",
            "active",
            "archived",
            "pendingDeletion"
          ]
        }
      },
      "risk": "read",
      "surfaces": [
        "thread",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "artifacts.update": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "artifacts",
      "description": "Replace an inline markdown/text artifact with a new version. Read with artifacts.readContent first, pass the returned expectedVersionId, and optionally expectedContentHash to avoid overwriting concurrent edits. Use this like a whole-file markdown save.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "artifacts",
        "requiredExplicitInputFields": [
          "artifactId"
        ]
      },
      "featureFlagKey": "artifacts",
      "inputSchema": {
        "artifactId": {
          "kind": "string",
          "optional": true
        },
        "content": {
          "kind": "string"
        },
        "contentHash": {
          "kind": "string",
          "optional": true
        },
        "expectedContentHash": {
          "kind": "string",
          "optional": true
        },
        "expectedVersionId": {
          "kind": "string"
        },
        "slug": {
          "kind": "string",
          "optional": true
        },
        "summary": {
          "kind": "string",
          "optional": true
        },
        "tags": {
          "items": {
            "kind": "string"
          },
          "kind": "array",
          "optional": true
        },
        "title": {
          "kind": "string",
          "optional": true
        },
        "versionMetadata": {
          "kind": "record",
          "optional": true,
          "value": {
            "kind": "unknown"
          }
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "thread",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "automations.create": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "automations",
      "description": "Create a space-scoped scheduled agent automation, loop, or trigger. Set approvalLevel='full_permissions' only when the user explicitly asks for trusted automation to run without per-action approvals. For loops, set startImmediately=true to run the first step now, or provide schedule to start later. Use loopKind=goal with goalPrompt, goalEvaluationPrompt, and maxIterations when the loop should stop after runtime goal evaluation. For thread-event triggers, prefer triggerConfig with spaceScope, spaceId, threadTagIds, and threadTagMatch ('all' or 'any'); threadTagSlugs is accepted only for legacy compatibility. For a database record changed or row updated trigger, set automationType='trigger', triggerKind='database_mutation', and triggerConfig={tableId:'<database slug or ID>', operations:['create','update','archive','restore']}; tableId may be a dynamic database slug or ID, and this watches the table for records created, updated, archived, or restored. Inspect existing databases with databases.list before choosing a table.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "automations",
        "requiredExplicitInputFields": [
          "agentIdOrSlug",
          "spaceIdOrSlug"
        ]
      },
      "inputSchema": {
        "agentId": {
          "kind": "string",
          "optional": true
        },
        "agentIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "approvalLevel": {
          "kind": "enum",
          "optional": true,
          "values": [
            "ask",
            "full_permissions"
          ]
        },
        "automationType": {
          "kind": "enum",
          "optional": true,
          "values": [
            "scheduled",
            "loop",
            "trigger"
          ]
        },
        "continuationPrompt": {
          "kind": "string",
          "optional": true
        },
        "goalEvaluationPrompt": {
          "kind": "string",
          "optional": true
        },
        "goalPrompt": {
          "kind": "string",
          "optional": true
        },
        "loopKind": {
          "kind": "enum",
          "optional": true,
          "values": [
            "finite",
            "infinite",
            "goal"
          ]
        },
        "maxIterations": {
          "kind": "number",
          "optional": true
        },
        "name": {
          "kind": "string"
        },
        "prompt": {
          "kind": "string"
        },
        "schedule": {
          "kind": "union",
          "optional": true,
          "options": [
            {
              "fields": {
                "runAt": {
                  "kind": "number"
                },
                "type": {
                  "kind": "literal",
                  "value": "once"
                }
              },
              "kind": "object"
            },
            {
              "fields": {
                "intervalMs": {
                  "kind": "number"
                },
                "startAt": {
                  "kind": "number",
                  "optional": true
                },
                "type": {
                  "kind": "literal",
                  "value": "interval"
                }
              },
              "kind": "object"
            },
            {
              "fields": {
                "cron": {
                  "kind": "string"
                },
                "startAt": {
                  "kind": "number",
                  "optional": true
                },
                "timezone": {
                  "kind": "string",
                  "optional": true
                },
                "type": {
                  "kind": "literal",
                  "value": "cron"
                }
              },
              "kind": "object"
            }
          ]
        },
        "spaceId": {
          "kind": "string",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "startImmediately": {
          "kind": "boolean",
          "optional": true
        },
        "threadMode": {
          "kind": "enum",
          "optional": true,
          "values": [
            "new-thread",
            "reuse-thread"
          ]
        },
        "triggerConfig": {
          "kind": "record",
          "optional": true,
          "value": {
            "kind": "unknown"
          }
        },
        "triggerKind": {
          "kind": "enum",
          "optional": true,
          "values": [
            "thread_created",
            "assistant_turn_completed",
            "thread_failed",
            "automation_completed",
            "webhook",
            "database_mutation"
          ]
        },
        "triggerMode": {
          "kind": "enum",
          "optional": true,
          "values": [
            "scheduled",
            "loop"
          ]
        },
        "triggerRiskAcknowledgements": {
          "items": {
            "kind": "string"
          },
          "kind": "array",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "automation",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "automations.disable": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "automations",
      "description": "Use this to disable a scheduled agent automation and cancel pending schedule handles.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "automations",
        "requiredExplicitInputFields": [
          "automationId"
        ]
      },
      "inputSchema": {
        "automationId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "automation",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "automations.get": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "automations",
      "description": "Read one scheduled agent automation and recent run history.",
      "effect": "read",
      "executionMode": "read",
      "externalAccess": {
        "capabilityPack": "automations",
        "requiredExplicitInputFields": [
          "automationId"
        ]
      },
      "inputSchema": {
        "automationId": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "automation",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "automations.list": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "automations",
      "description": "List space-scoped scheduled agent automations.",
      "effect": "read",
      "executionMode": "read",
      "externalAccess": {
        "capabilityPack": "automations",
        "requiredExplicitInputFields": [
          "spaceIdOrSlug"
        ]
      },
      "inputSchema": {
        "includeDisabled": {
          "kind": "boolean",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "automation",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "automations.runNow": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "automations",
      "description": "Run a scheduled agent automation immediately.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "automations",
        "requiredExplicitInputFields": [
          "automationId"
        ]
      },
      "inputSchema": {
        "automationId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "automation",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "automations.update": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "automations",
      "description": "Update a space-scoped scheduled agent automation, loop, or trigger. Set approvalLevel='full_permissions' only when the user explicitly asks for trusted automation to run without per-action approvals. For thread-event triggers, prefer triggerConfig with spaceScope, spaceId, threadTagIds, and threadTagMatch ('all' or 'any'); threadTagSlugs is accepted only for legacy compatibility. For a database record changed or row updated trigger, set automationType='trigger', triggerKind='database_mutation', and triggerConfig={tableId:'<database slug or ID>', operations:['create','update','archive','restore']}; tableId may be a dynamic database slug or ID, and this watches the table for records created, updated, archived, or restored. Inspect existing databases with databases.list before choosing a table.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "automations",
        "requiredExplicitInputFields": [
          "automationId"
        ]
      },
      "inputSchema": {
        "agentId": {
          "kind": "string",
          "optional": true
        },
        "agentIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "approvalLevel": {
          "kind": "enum",
          "optional": true,
          "values": [
            "ask",
            "full_permissions"
          ]
        },
        "automationId": {
          "kind": "string"
        },
        "automationType": {
          "kind": "enum",
          "optional": true,
          "values": [
            "scheduled",
            "loop",
            "trigger"
          ]
        },
        "continuationPrompt": {
          "kind": "string",
          "optional": true
        },
        "enabled": {
          "kind": "boolean",
          "optional": true
        },
        "goalEvaluationPrompt": {
          "kind": "string",
          "optional": true
        },
        "goalPrompt": {
          "kind": "string",
          "optional": true
        },
        "loopKind": {
          "kind": "enum",
          "optional": true,
          "values": [
            "finite",
            "infinite",
            "goal"
          ]
        },
        "maxIterations": {
          "kind": "number",
          "optional": true
        },
        "name": {
          "kind": "string",
          "optional": true
        },
        "prompt": {
          "kind": "string",
          "optional": true
        },
        "schedule": {
          "kind": "union",
          "optional": true,
          "options": [
            {
              "fields": {
                "runAt": {
                  "kind": "number"
                },
                "type": {
                  "kind": "literal",
                  "value": "once"
                }
              },
              "kind": "object"
            },
            {
              "fields": {
                "intervalMs": {
                  "kind": "number"
                },
                "startAt": {
                  "kind": "number",
                  "optional": true
                },
                "type": {
                  "kind": "literal",
                  "value": "interval"
                }
              },
              "kind": "object"
            },
            {
              "fields": {
                "cron": {
                  "kind": "string"
                },
                "startAt": {
                  "kind": "number",
                  "optional": true
                },
                "timezone": {
                  "kind": "string",
                  "optional": true
                },
                "type": {
                  "kind": "literal",
                  "value": "cron"
                }
              },
              "kind": "object"
            }
          ]
        },
        "threadMode": {
          "kind": "enum",
          "optional": true,
          "values": [
            "new-thread",
            "reuse-thread"
          ]
        },
        "triggerConfig": {
          "kind": "record",
          "optional": true,
          "value": {
            "kind": "unknown"
          }
        },
        "triggerKind": {
          "kind": "enum",
          "optional": true,
          "values": [
            "thread_created",
            "assistant_turn_completed",
            "thread_failed",
            "automation_completed",
            "webhook",
            "database_mutation"
          ]
        },
        "triggerMode": {
          "kind": "enum",
          "optional": true,
          "values": [
            "scheduled",
            "loop"
          ]
        },
        "triggerRiskAcknowledgements": {
          "items": {
            "kind": "string"
          },
          "kind": "array",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "automation",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "bridgeDevices.cancelPendingControl": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "admin",
      "description": "Use this to cancel a pending bridge update, restart, or control action before the device runs it.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "inputSchema": {
        "deviceId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "bridgeDevices.delete": {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "admin",
      "description": "Use this to permanently remove a revoked bridge device record from settings.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "inputSchema": {
        "deviceId": {
          "kind": "string"
        }
      },
      "risk": "destructive",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "bridgeDevices.list": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "admin",
      "description": "Use this to list connected bridge devices, their status, capabilities, active sessions, and queued work.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {},
      "risk": "read",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "bridgeDevices.refreshHermesProfiles": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "admin",
      "description": "Use this to ask a bridge device to refresh Hermes agent profile discovery.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "inputSchema": {
        "deviceId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "bridgeDevices.renameLocation": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "admin",
      "description": "Use this to rename the human-readable location label for a bridge device.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "inputSchema": {
        "deviceId": {
          "kind": "string"
        },
        "label": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "bridgeDevices.requestRestartWhenIdle": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "admin",
      "description": "Use this to ask a bridge device to restart the next time it is idle.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "inputSchema": {
        "deviceId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "bridgeDevices.requestUpdateWhenIdle": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "admin",
      "description": "Use this to ask a bridge device to update itself the next time it is idle.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "inputSchema": {
        "deviceId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "bridgeDevices.revoke": {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "admin",
      "description": "Use this to revoke a bridge device and terminalize its active bridge sessions and queued work.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "inputSchema": {
        "deviceId": {
          "kind": "string"
        }
      },
      "risk": "destructive",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "capabilities.advise": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "core",
      "description": "Consult 0000 Architect for a machine-readable 0000-native plan for a desired outcome. Use this for planning/advice before composing spaces, threads, tags, databases, OpenUI apps, automations, actions, artifacts, typed references, or user prompts; it does not execute writes.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "availablePacks": {
          "items": {
            "kind": "string"
          },
          "kind": "array",
          "optional": true
        },
        "availableTools": {
          "items": {
            "kind": "string"
          },
          "kind": "array",
          "optional": true
        },
        "constraints": {
          "kind": "string",
          "optional": true
        },
        "currentContext": {
          "kind": "string",
          "optional": true
        },
        "desiredOutcome": {
          "kind": "string"
        }
      },
      "risk": "read",
      "visibility": "core"
    },
    "capabilities.describe": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "core",
      "description": "Describe 0000 Chat MCP tool capabilities, core tools, surface-scoped tools, and workflow guides. Use this before choosing from deferred or surface-scoped tool packs.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "guideId": {
          "kind": "string",
          "optional": true
        },
        "query": {
          "kind": "string",
          "optional": true
        },
        "surface": {
          "kind": "enum",
          "optional": true,
          "values": [
            "thread",
            "space",
            "database",
            "app",
            "automation",
            "settings",
            "action"
          ]
        }
      },
      "risk": "read",
      "visibility": "core"
    },
    "context.get": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "core",
      "description": "Read the current 0000 Chat operating context as typed object references for the active thread, space, and agent session. Prefer this before resolving objects from ambiguous user phrasing.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {},
      "risk": "read",
      "visibility": "core"
    },
    "databases.create": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Create a dynamic database table.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "color": {
          "kind": "string",
          "optional": true
        },
        "description": {
          "kind": "string",
          "optional": true
        },
        "icon": {
          "kind": "string",
          "optional": true
        },
        "name": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.createField": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Create a field on a dynamic database table. Prefer fieldPreset when possible: short_text for titles/names, boolean for is/has flags, number for counts/prices/scores, date for dates, tags for tag lists, url/email/phone for contact fields, single_select or multi_select for bounded choices, long_text for notes, and article_markdown/markdown only for article or body content. For single_select and multi_select fields, pass options:[{key,label,color?}] in the same call; option keys are the row values. Supported attributeType values include text_single, text_multi, number, currency, datetime, checkbox, select_single, select_multi, email, url, phone, text_array, attachments, entity_reference, relationship, and ai_agent. Use referenceEntityTypeId for entity_reference fields.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "attributeType": {
          "kind": "string",
          "optional": true
        },
        "config": {
          "kind": "record",
          "optional": true,
          "value": {
            "kind": "unknown"
          }
        },
        "defaultValue": {
          "kind": "string",
          "optional": true
        },
        "description": {
          "kind": "string",
          "optional": true
        },
        "displayName": {
          "kind": "string"
        },
        "fieldKey": {
          "kind": "string",
          "optional": true
        },
        "fieldPreset": {
          "kind": "string",
          "optional": true
        },
        "isEditable": {
          "kind": "boolean",
          "optional": true
        },
        "isHidden": {
          "kind": "boolean",
          "optional": true
        },
        "isRequired": {
          "kind": "boolean",
          "optional": true
        },
        "isUnique": {
          "kind": "boolean",
          "optional": true
        },
        "options": {
          "items": {
            "fields": {
              "color": {
                "kind": "string",
                "optional": true
              },
              "key": {
                "kind": "string"
              },
              "label": {
                "kind": "string"
              }
            },
            "kind": "object"
          },
          "kind": "array",
          "optional": true
        },
        "referenceEntityTypeId": {
          "kind": "string",
          "optional": true
        },
        "tableId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.createRelationship": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Create a first-class relationship instance between two existing rows using a relationship definition. Validates ownership and source/target table compatibility.",
      "effect": "row_write",
      "executionMode": "mutation",
      "inputSchema": {
        "metadata": {
          "kind": "record",
          "optional": true,
          "value": {
            "kind": "unknown"
          }
        },
        "relationshipDefinitionId": {
          "kind": "string"
        },
        "sourceRowId": {
          "kind": "string"
        },
        "targetRowId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.createRelationshipDefinition": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Create a first-class relationship type between two dynamic database tables. This powers related-record tabs and validated relationship instances; do not use ordinary text/JSON fields for true relationships.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "cardinality": {
          "kind": "enum",
          "values": [
            "one_to_one",
            "one_to_many",
            "many_to_one",
            "many_to_many"
          ]
        },
        "displayName": {
          "kind": "string"
        },
        "metadataFields": {
          "items": {
            "fields": {
              "displayName": {
                "kind": "string"
              },
              "fieldKey": {
                "kind": "string"
              },
              "fieldType": {
                "kind": "enum",
                "values": [
                  "text_single",
                  "checkbox",
                  "select_single",
                  "number",
                  "date"
                ]
              },
              "required": {
                "kind": "boolean",
                "optional": true
              }
            },
            "kind": "object"
          },
          "kind": "array",
          "optional": true
        },
        "relationshipKey": {
          "kind": "string"
        },
        "reverseDisplayName": {
          "kind": "string"
        },
        "sourceTableIdOrSlug": {
          "kind": "string"
        },
        "targetTableIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.createRow": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Create a row in a dynamic database table.",
      "effect": "row_write",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "databases_records",
        "requiredExplicitInputFields": [
          "tableId"
        ]
      },
      "inputSchema": {
        "attributes": {
          "kind": "record",
          "optional": true,
          "value": {
            "kind": "unknown"
          }
        },
        "tableId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.delete": {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Archive one dynamic database table by immutable ID. First call without confirmation to review impact; repeat with confirmation='DELETE' to archive it.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "confirmation": {
          "kind": "literal",
          "optional": true,
          "value": "DELETE"
        },
        "tableId": {
          "kind": "string"
        }
      },
      "risk": "destructive",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.deleteField": {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Archive one dynamic database field by immutable ID. First call without confirmation to review impact; repeat with confirmation='DELETE' to archive it.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "confirmation": {
          "kind": "literal",
          "optional": true,
          "value": "DELETE"
        },
        "fieldId": {
          "kind": "string"
        }
      },
      "risk": "destructive",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.deleteRelationship": {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Delete one first-class relationship instance. Pass a rowId from either side so the tool can verify the relationship belongs to a row the agent can access.",
      "effect": "row_write",
      "executionMode": "mutation",
      "inputSchema": {
        "relationshipId": {
          "kind": "string"
        },
        "rowId": {
          "kind": "string"
        }
      },
      "risk": "destructive",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.deleteRelationshipDefinition": {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Delete one dynamic database relationship definition by immutable ID. First call without confirmation to review impact; repeat with confirmation='DELETE' to delete it.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "confirmation": {
          "kind": "literal",
          "optional": true,
          "value": "DELETE"
        },
        "relationshipDefinitionId": {
          "kind": "string"
        }
      },
      "risk": "destructive",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.deleteRow": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Archive a row in a dynamic database table.",
      "effect": "row_write",
      "executionMode": "mutation",
      "inputSchema": {
        "rowId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.get": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "databases",
      "description": "Read one dynamic database table definition.",
      "effect": "read",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "databases_records",
        "requiredExplicitInputFields": [
          "tableIdOrSlug"
        ]
      },
      "inputSchema": {
        "tableIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.getRow": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "databases",
      "description": "Read one row in a dynamic database table.",
      "effect": "read",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "databases_records",
        "requiredExplicitInputFields": [
          "rowId"
        ]
      },
      "inputSchema": {
        "rowId": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.list": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "databases",
      "description": "List user-created dynamic database tables.",
      "effect": "read",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "databases_records"
      },
      "inputSchema": {
        "includeArchived": {
          "kind": "boolean",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.listFieldOptions": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "databases",
      "description": "List one bounded page of options for a select field. Continue with the opaque cursor until isDone when the complete catalog is needed.",
      "effect": "read",
      "executionMode": "mutation",
      "inputSchema": {
        "cursor": {
          "kind": "string",
          "optional": true
        },
        "fieldIdOrKey": {
          "kind": "string"
        },
        "limit": {
          "kind": "number",
          "optional": true
        },
        "tableIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.listRelationshipDefinitions": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "databases",
      "description": "List true relationship definitions connected to a dynamic database table. Use this before creating relationship instances so agents do not fake links with raw row IDs.",
      "effect": "read",
      "executionMode": "mutation",
      "inputSchema": {
        "direction": {
          "kind": "enum",
          "optional": true,
          "values": [
            "source",
            "target",
            "both"
          ]
        },
        "tableIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.listRowRelationships": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "databases",
      "description": "List one bounded page of true related-record links for a dynamic database row, including source/target row ids, labels, metadata, related row summaries, and an opaque continuation cursor.",
      "effect": "read",
      "executionMode": "mutation",
      "inputSchema": {
        "cursor": {
          "kind": "string",
          "optional": true
        },
        "direction": {
          "kind": "enum",
          "optional": true,
          "values": [
            "forward",
            "reverse",
            "both"
          ]
        },
        "limit": {
          "kind": "number",
          "optional": true
        },
        "relationshipDefinitionId": {
          "kind": "string",
          "optional": true
        },
        "rowId": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.listRows": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "databases",
      "description": "List rows in a dynamic database table.",
      "effect": "read",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "databases_records",
        "requiredExplicitInputFields": [
          "tableIdOrSlug"
        ]
      },
      "inputSchema": {
        "cursor": {
          "kind": "string",
          "optional": true
        },
        "includeArchived": {
          "kind": "boolean",
          "optional": true
        },
        "limit": {
          "kind": "number",
          "optional": true
        },
        "tableIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.searchRows": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "databases",
      "description": "Search rows in a dynamic database table.",
      "effect": "read",
      "executionMode": "mutation",
      "inputSchema": {
        "limit": {
          "kind": "number",
          "optional": true
        },
        "query": {
          "kind": "string"
        },
        "searchFields": {
          "items": {
            "kind": "string"
          },
          "kind": "array",
          "optional": true
        },
        "tableIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databases.updateRow": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Update a row in a dynamic database table.",
      "effect": "row_write",
      "executionMode": "mutation",
      "externalAccess": {
        "capabilityPack": "databases_records",
        "requiredExplicitInputFields": [
          "rowId"
        ]
      },
      "inputSchema": {
        "attributes": {
          "kind": "record",
          "value": {
            "kind": "unknown"
          }
        },
        "rowId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databaseViews.create": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Use this to create a saved database table view with filters, sorting, visible columns, search, and page-size preferences.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "config": {
          "kind": "record",
          "value": {
            "kind": "unknown"
          }
        },
        "isDefault": {
          "kind": "boolean",
          "optional": true
        },
        "name": {
          "kind": "string"
        },
        "tableIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databaseViews.delete": {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Use this to delete a non-default saved database view that is no longer needed.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "viewId": {
          "kind": "string"
        }
      },
      "risk": "destructive",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databaseViews.duplicate": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Use this to duplicate an existing saved database view before experimenting with a new layout or filter set.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "name": {
          "kind": "string",
          "optional": true
        },
        "viewId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databaseViews.get": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "databases",
      "description": "Use this to read one saved database view configuration by id before editing or duplicating it.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "viewId": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databaseViews.getDefault": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "databases",
      "description": "Use this to read the default saved view for a dynamic database table.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "tableIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databaseViews.list": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "databases",
      "description": "Use this to list saved views for a dynamic database table before changing table layout, filters, sorting, or pagination defaults.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "tableIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databaseViews.rename": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Use this to rename an existing saved database view without changing its configuration.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "name": {
          "kind": "string"
        },
        "viewId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databaseViews.setDefault": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Use this to make an existing saved database view the default view for its table.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "viewId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "databaseViews.updateConfig": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "databases",
      "description": "Use this to update the configuration for an existing saved database view.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "config": {
          "kind": "record",
          "value": {
            "kind": "unknown"
          }
        },
        "viewId": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "database",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "machineEnrollments.create": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "admin",
      "description": "Use this to create a short-lived Machine enrollment. Set registerAgent when the Machine should also report proposed Agent targets.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "featureFlagKey": "machines",
      "inputSchema": {
        "registerAgent": {
          "kind": "boolean",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "machineEnrollments.listActive": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "admin",
      "description": "Use this to list active Machine enrollments and their registration state.",
      "effect": "read",
      "executionMode": "read",
      "featureFlagKey": "machines",
      "inputSchema": {},
      "risk": "read",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "machineEnrollments.regenerate": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "admin",
      "description": "Use this to replace an unregistered Machine enrollment with a new short-lived enrollment.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "featureFlagKey": "machines",
      "inputSchema": {
        "enrollmentId": {
          "kind": "string"
        },
        "registerAgent": {
          "kind": "boolean",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "messages.search": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "threads",
      "description": "Search cached 0000 Chat messages across accessible threads in the current organization. Use for explicit cross-thread or historical search. Do not use for current-thread continuity after revive/resume/compaction; use context.get, threads.current, or threads.read instead.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "limit": {
          "kind": "number",
          "optional": true
        },
        "query": {
          "kind": "string"
        },
        "threadId": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "notifications.getBrowserConfig": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "admin",
      "description": "Use this to inspect whether browser push notification configuration is available for the current user.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {},
      "risk": "read",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "notifications.getBrowserSubscriptionStatus": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "admin",
      "description": "Use this to check the current browser push subscription status, optionally for a specific endpoint.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "endpoint": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "notifications.getNativeDeviceStatus": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "admin",
      "description": "Use this to check registered native notification device status for the current install or a named install id.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "installId": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "notifications.registerNativeDevice": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "admin",
      "description": "Use this to register or refresh a native shell notification device for the current user.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "inputSchema": {
        "appVersion": {
          "kind": "string",
          "optional": true
        },
        "installId": {
          "kind": "string"
        },
        "permission": {
          "kind": "enum",
          "values": [
            "default",
            "denied",
            "granted",
            "unsupported"
          ]
        },
        "platform": {
          "kind": "string",
          "optional": true
        },
        "releaseChannel": {
          "kind": "string",
          "optional": true
        },
        "runtime": {
          "kind": "enum",
          "values": [
            "tauri-desktop",
            "tauri-mobile"
          ]
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "notifications.subscribeBrowser": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "admin",
      "description": "Use this to register or refresh a browser push notification subscription for the current user.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "inputSchema": {
        "deviceLabel": {
          "kind": "string",
          "optional": true
        },
        "subscription": {
          "fields": {
            "endpoint": {
              "kind": "string"
            },
            "keys": {
              "fields": {
                "auth": {
                  "kind": "string"
                },
                "p256dh": {
                  "kind": "string"
                }
              },
              "kind": "object"
            }
          },
          "kind": "object"
        },
        "userAgent": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "notifications.unregisterNativeDevice": {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "admin",
      "description": "Use this to unregister a native shell notification device for the current user.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "inputSchema": {
        "installId": {
          "kind": "string"
        }
      },
      "risk": "destructive",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "notifications.unsubscribeBrowser": {
      "annotations": {
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "admin",
      "description": "Use this to revoke a browser push notification subscription endpoint for the current user.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "inputSchema": {
        "endpoint": {
          "kind": "string"
        }
      },
      "risk": "destructive",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "objects.get": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "core",
      "description": "Read one first-class 0000 Chat object through a typed reference. Thread objects return metadata by default; pass include: [\"content\"] for the latest bounded transcript, or use threads.read. Use after context.get, objects.search, or another tool returns an object ref.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "include": {
          "items": {
            "kind": "enum",
            "optional": true,
            "values": [
              "metadata",
              "content",
              "links"
            ]
          },
          "kind": "array",
          "optional": true
        },
        "object": {
          "fields": {
            "id": {
              "kind": "string"
            },
            "type": {
              "kind": "enum",
              "values": [
                "thread",
                "message",
                "space",
                "app",
                "automation",
                "database",
                "record",
                "artifact",
                "action"
              ]
            }
          },
          "kind": "object"
        }
      },
      "risk": "read",
      "visibility": "core"
    },
    "objects.listLinked": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "core",
      "description": "List first-class 0000 Chat objects linked to a typed object reference. Use this to discover related artifacts and context without guessing ids.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "object": {
          "fields": {
            "id": {
              "kind": "string"
            },
            "type": {
              "kind": "enum",
              "values": [
                "thread",
                "message",
                "space",
                "app",
                "automation",
                "database",
                "record",
                "artifact",
                "action"
              ]
            }
          },
          "kind": "object"
        },
        "relationship": {
          "kind": "enum",
          "optional": true,
          "values": [
            "source",
            "reference",
            "result",
            "embedded",
            "mentioned"
          ]
        },
        "types": {
          "items": {
            "kind": "enum",
            "values": [
              "thread",
              "message",
              "space",
              "app",
              "automation",
              "database",
              "record",
              "artifact",
              "action"
            ]
          },
          "kind": "array",
          "optional": true
        }
      },
      "risk": "read",
      "visibility": "core"
    },
    "objects.search": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "core",
      "description": "Search first-class 0000 Chat objects by type and query, returning typed object references agents can pass to objects.get or objects.listLinked.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "limit": {
          "kind": "number",
          "optional": true
        },
        "query": {
          "kind": "string"
        },
        "types": {
          "items": {
            "kind": "enum",
            "values": [
              "thread",
              "message",
              "space",
              "app",
              "automation",
              "database",
              "record",
              "artifact",
              "action"
            ]
          },
          "kind": "array",
          "optional": true
        }
      },
      "risk": "read",
      "visibility": "core"
    },
    "runtime.readEvidence": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "runtime",
      "description": "Read bounded, organization-scoped runtime lifecycle aggregates. Returns allowlisted counts by event, entity, and next state only; never returns raw logs, prompts, content, secrets, cookies, tokens, or client-supplied organization scope. This is telemetry evidence only and does not perform deployment or rollback mutations.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "limit": {
          "kind": "number",
          "optional": true
        },
        "windowMs": {
          "kind": "number",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "thread",
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "secrets.listAvailable": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "actions",
      "description": "List metadata for secrets available to generated actions without revealing values.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "query": {
          "kind": "string",
          "optional": true
        },
        "scopes": {
          "items": {
            "kind": "enum",
            "values": [
              "user",
              "organization"
            ]
          },
          "kind": "array",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "action",
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "secrets.put": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "admin",
      "description": "Encrypt and store a user or organization secret. Secret values are redacted from approvals and tool logs.",
      "effect": "secret_write",
      "executionMode": "mutation",
      "inputSchema": {
        "name": {
          "kind": "string"
        },
        "scope": {
          "kind": "enum",
          "values": [
            "user",
            "organization"
          ]
        },
        "value": {
          "kind": "string",
          "sensitive": true
        }
      },
      "risk": "secret",
      "sensitiveInput": true,
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "secrets.requestCollection": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "threads",
      "description": "Ask the user to add one or more secrets through the secure in-thread form. Use this instead of asking for secret text in chat; provide only editable secret metadata templates.",
      "effect": "interaction_write",
      "executionMode": "mutation",
      "inputSchema": {
        "maxRows": {
          "kind": "number",
          "optional": true
        },
        "prompt": {
          "kind": "string",
          "optional": true
        },
        "rows": {
          "items": {
            "fields": {
              "allowedHosts": {
                "items": {
                  "kind": "string"
                },
                "kind": "array",
                "optional": true
              },
              "allowedUses": {
                "items": {
                  "kind": "string"
                },
                "kind": "array",
                "optional": true
              },
              "name": {
                "kind": "string"
              },
              "purpose": {
                "kind": "string",
                "optional": true
              },
              "scope": {
                "kind": "enum",
                "values": [
                  "user",
                  "organization"
                ]
              }
            },
            "kind": "object"
          },
          "kind": "array"
        }
      },
      "risk": "user_interaction",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "settings.setDefaultApprovalLevel": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "explicit_trust_boundary",
      "capabilityPack": "admin",
      "description": "Set the user's default approval mode for future 0000 Chat threads. Use approvalLevel='full_permissions' only when the user explicitly asks to enable trusted local automation. This tool always requires an in-thread approval unless the current thread is already full-permissions.",
      "effect": "admin_write",
      "executionMode": "mutation",
      "inputSchema": {
        "approvalLevel": {
          "kind": "enum",
          "optional": true,
          "values": [
            "ask",
            "full_permissions"
          ]
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "spaces.archive": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "spaces",
      "description": "Archive a 0000 Chat space.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "spaceIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "spaces.create": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "spaces",
      "description": "Create a 0000 Chat space, including title, description, icon/color, favorite status, auto-archive timing, and the space systemPrompt.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "autoArchiveInactiveThreadsAfterHours": {
          "kind": "number",
          "nullable": true,
          "optional": true
        },
        "color": {
          "kind": "string",
          "optional": true
        },
        "description": {
          "kind": "string",
          "optional": true
        },
        "favorite": {
          "kind": "boolean",
          "optional": true
        },
        "icon": {
          "kind": "string",
          "optional": true
        },
        "systemPrompt": {
          "kind": "string",
          "optional": true
        },
        "title": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "spaces.get": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "spaces",
      "description": "Read one 0000 Chat space by id or slug.",
      "effect": "read",
      "executionMode": "read",
      "externalAccess": {
        "capabilityPack": "organizations_spaces",
        "requiredExplicitInputFields": [
          "spaceIdOrSlug"
        ]
      },
      "inputSchema": {
        "includeArchived": {
          "kind": "boolean",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "spaces.list": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "spaces",
      "description": "List 0000 Chat spaces in the current organization.",
      "effect": "read",
      "executionMode": "read",
      "externalAccess": {
        "capabilityPack": "organizations_spaces"
      },
      "inputSchema": {
        "includeArchived": {
          "kind": "boolean",
          "optional": true
        },
        "limit": {
          "kind": "number",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "spaces.unarchive": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "spaces",
      "description": "Restore an archived 0000 Chat space.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "spaceIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "spaces.update": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "spaces",
      "description": "Update a 0000 Chat space, including title, URL slug, description, icon/color, favorite status, auto-archive timing, and the space systemPrompt.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "autoArchiveInactiveThreadsAfterHours": {
          "kind": "number",
          "nullable": true,
          "optional": true
        },
        "color": {
          "kind": "string",
          "optional": true
        },
        "description": {
          "kind": "string",
          "optional": true
        },
        "favorite": {
          "kind": "boolean",
          "optional": true
        },
        "icon": {
          "kind": "string",
          "optional": true
        },
        "slug": {
          "kind": "string",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string"
        },
        "systemPrompt": {
          "kind": "string",
          "optional": true
        },
        "title": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "space"
      ],
      "visibility": "surface-scoped"
    },
    "tags.archive": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "threads",
      "description": "Archive an organization tag by default, or a space-owned tag when its spaceIdOrSlug is provided.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "tagIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "tags.assign": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "threads",
      "description": "Assign an organization tag by default, or a space-owned tag when its spaceIdOrSlug is provided. The target must belong to that space.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "tagIdOrSlug": {
          "kind": "string"
        },
        "targetId": {
          "kind": "string"
        },
        "targetType": {
          "kind": "enum",
          "values": [
            "thread",
            "artifact",
            "database_table"
          ]
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "tags.create": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "threads",
      "description": "Create an organization tag by default, or a tag owned by one space when spaceIdOrSlug is provided.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "color": {
          "kind": "string",
          "optional": true
        },
        "description": {
          "kind": "string",
          "optional": true
        },
        "name": {
          "kind": "string"
        },
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "tags.list": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "threads",
      "description": "List organization tags by default, or tags owned by one space when spaceIdOrSlug is provided. Space-scoped results require the space-scoped-tags feature.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "includeArchived": {
          "kind": "boolean",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "tags.listForTarget": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "threads",
      "description": "List valid tags assigned to a thread, artifact, or database table. Optionally pass spaceIdOrSlug to assert the target space.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "targetId": {
          "kind": "string"
        },
        "targetType": {
          "kind": "enum",
          "values": [
            "thread",
            "artifact",
            "database_table"
          ]
        }
      },
      "risk": "read",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "tags.unassign": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "threads",
      "description": "Remove an organization tag assignment by default, or a space-owned tag assignment when its spaceIdOrSlug is provided. The target must belong to that space.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "tagIdOrSlug": {
          "kind": "string"
        },
        "targetId": {
          "kind": "string"
        },
        "targetType": {
          "kind": "enum",
          "values": [
            "thread",
            "artifact",
            "database_table"
          ]
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "tags.update": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "threads",
      "description": "Update an organization tag by default, or a space-owned tag when its spaceIdOrSlug is provided.",
      "effect": "schema_write",
      "executionMode": "mutation",
      "inputSchema": {
        "color": {
          "kind": "string",
          "optional": true
        },
        "description": {
          "kind": "string",
          "optional": true
        },
        "name": {
          "kind": "string",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "tagIdOrSlug": {
          "kind": "string"
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "threads.contextDescribe": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "threads",
      "description": "Describe one lossless thread context memory node, including summary metadata, parent/child node ids, and exact source message ids without expanding raw message content.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "nodeId": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "threads.contextExpand": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "threads",
      "description": "Expand one lossless thread context memory node into child context nodes and, when includeMessages=true, bounded exact source messages linked to that node.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "includeMessages": {
          "kind": "boolean",
          "optional": true
        },
        "limit": {
          "kind": "number",
          "optional": true
        },
        "nodeId": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "threads.contextList": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "threads",
      "description": "List ready lossless thread context memory nodes for a 0000 Chat thread, plus active/recent summarization work status. Defaults to the current thread. Use query to search summaries, then threads.contextDescribe or threads.contextExpand to inspect exact source links.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "limit": {
          "kind": "number",
          "optional": true
        },
        "query": {
          "kind": "string",
          "optional": true
        },
        "threadId": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "threads.continue": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "threads",
      "description": "Continue an existing authorized 0000 Chat thread by starting an agent-authored turn. Defaults to the current thread; pass threadId to continue another non-archived thread in the caller organization. Pass agentIdOrSlug: \"self\" to continue as the calling agent, or another usable agent id/slug to hand off. This records agent provenance and must not be used to simulate a user-authored message.",
      "effect": "interaction_write",
      "executionMode": "mutation",
      "inputSchema": {
        "agentIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "approvalLevel": {
          "kind": "enum",
          "optional": true,
          "values": [
            "ask",
            "full_permissions"
          ]
        },
        "instruction": {
          "kind": "string"
        },
        "requireAgentSession": {
          "kind": "boolean",
          "optional": true
        },
        "threadId": {
          "kind": "string",
          "optional": true
        },
        "title": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "user_interaction",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "threads.create": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "threads",
      "description": "Create a new 0000 Chat thread in a space. By default this creates a thread and agent session without messages; pass agentIdOrSlug to assign the thread to another usable agent, or pass agentIdOrSlug: \"self\" to assign it to the calling agent. Pass initialUserMessage only when the user explicitly wants that text carried into the new thread as the first user message.",
      "effect": "interaction_write",
      "executionMode": "mutation",
      "inputSchema": {
        "agentIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "approvalLevel": {
          "kind": "enum",
          "optional": true,
          "values": [
            "ask",
            "full_permissions"
          ]
        },
        "clientThreadId": {
          "kind": "string",
          "optional": true
        },
        "initialUserMessage": {
          "kind": "string",
          "optional": true
        },
        "requireAgentSession": {
          "kind": "boolean",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string"
        },
        "summary": {
          "kind": "string",
          "optional": true
        },
        "title": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "user_interaction",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "threads.createChild": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "threads",
      "description": "Create a new child thread under an authorized non-archived parent thread, in the parent's space. Pass initialUserMessage only when the user explicitly wants that text carried into the child.",
      "effect": "interaction_write",
      "executionMode": "mutation",
      "inputSchema": {
        "agentIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "approvalLevel": {
          "kind": "enum",
          "optional": true,
          "values": [
            "ask",
            "full_permissions"
          ]
        },
        "clientThreadId": {
          "kind": "string",
          "optional": true
        },
        "initialUserMessage": {
          "kind": "string",
          "optional": true
        },
        "parentThreadId": {
          "kind": "string"
        },
        "requireAgentSession": {
          "kind": "boolean",
          "optional": true
        },
        "summary": {
          "kind": "string",
          "optional": true
        },
        "title": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "user_interaction",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "threads.current": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "core",
      "description": "Read the exact current 0000 Chat thread/session context for this agent run. Prefer this for continue, resume, or remember prompts.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {},
      "risk": "read",
      "visibility": "core"
    },
    "threads.fork": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "threads",
      "description": "Fork a 0000 Chat thread into a new independent thread with safe visible context and lineage. Defaults to the current thread, source space, and source thread agent when sourceThreadId, spaceIdOrSlug, or agentIdOrSlug are omitted; pass initialUserMessage only when the user explicitly wants that text to start the fork.",
      "effect": "interaction_write",
      "executionMode": "mutation",
      "inputSchema": {
        "agentIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "approvalLevel": {
          "kind": "enum",
          "optional": true,
          "values": [
            "ask",
            "full_permissions"
          ]
        },
        "forkReason": {
          "kind": "string",
          "optional": true
        },
        "initialUserMessage": {
          "kind": "string",
          "optional": true
        },
        "requireAgentSession": {
          "kind": "boolean",
          "optional": true
        },
        "sourceThreadId": {
          "kind": "string",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "summary": {
          "kind": "string",
          "optional": true
        },
        "title": {
          "kind": "string",
          "optional": true
        },
        "upToMessageId": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "user_interaction",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "threads.list": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "threads",
      "description": "List recent 0000 Chat threads visible to this bridge session. Optionally filter by tag slugs/names, unreadOnly, and updatedSince; tagMatch defaults to all. Example: unread threads from the last 24 hours tagged project.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "limit": {
          "kind": "number",
          "optional": true
        },
        "tagMatch": {
          "kind": "enum",
          "optional": true,
          "values": [
            "all",
            "any"
          ]
        },
        "tags": {
          "items": {
            "kind": "string"
          },
          "kind": "array",
          "optional": true
        },
        "unreadOnly": {
          "kind": "boolean",
          "optional": true
        },
        "updatedSince": {
          "kind": "number",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "threads.listChildren": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "threads",
      "description": "List direct child threads for an authorized parent thread. Archived children are omitted.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "limit": {
          "kind": "number",
          "optional": true
        },
        "parentThreadId": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "threads.listChildrenByTags": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "threads",
      "description": "List direct child threads for an authorized parent thread whose active tags match all or any requested tags. Archived children are omitted.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "limit": {
          "kind": "number",
          "optional": true
        },
        "parentThreadId": {
          "kind": "string"
        },
        "tagMatch": {
          "kind": "enum",
          "optional": true,
          "values": [
            "all",
            "any"
          ]
        },
        "tags": {
          "items": {
            "kind": "string"
          },
          "kind": "array",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "threads.listDescendants": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "threads",
      "description": "List descendants at any depth for an authorized parent thread. Archived descendants are omitted.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "limit": {
          "kind": "number",
          "optional": true
        },
        "parentThreadId": {
          "kind": "string"
        }
      },
      "risk": "read",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "threads.read": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "core",
      "description": "Read one 0000 Chat thread and its recent cached messages. Use this for current-thread continuity when context.get or threads.current identifies the thread; do not use messages.search for current-thread recovery.",
      "effect": "read",
      "executionMode": "read",
      "externalAccess": {
        "capabilityPack": "explicit_threads",
        "requiredExplicitInputFields": [
          "threadId"
        ]
      },
      "inputSchema": {
        "limit": {
          "kind": "number",
          "optional": true
        },
        "threadId": {
          "kind": "string"
        }
      },
      "risk": "read",
      "visibility": "core"
    },
    "threads.readActivity": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false,
        "readOnlyHint": true
      },
      "approvalBehavior": "read_only",
      "capabilityPack": "threads",
      "description": "Read exact bounded durable 0000 Chat thread activity events. Defaults to the current thread and returns message_events oldest-to-newest for the selected sequence window. Use when recent cached messages from threads.read are not enough; do not use for broad message search.",
      "effect": "read",
      "executionMode": "read",
      "inputSchema": {
        "afterSequence": {
          "kind": "number",
          "optional": true
        },
        "beforeSequence": {
          "kind": "number",
          "optional": true
        },
        "limit": {
          "kind": "number",
          "optional": true
        },
        "threadId": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "read",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "threads.update": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "threads",
      "description": "Update lifecycle metadata for a 0000 Chat thread. Defaults to the current thread. Use for bounded thread title, summary, destination space, approval level, pin, or archive/unarchive changes; use tags.* for tag assignment and threads.continue for agent-authored work. Contradictory pinned+archived requests are rejected.",
      "effect": "interaction_write",
      "executionMode": "mutation",
      "inputSchema": {
        "approvalLevel": {
          "kind": "enum",
          "optional": true,
          "values": [
            "ask",
            "full_permissions"
          ]
        },
        "archived": {
          "kind": "boolean",
          "optional": true
        },
        "pinned": {
          "kind": "boolean",
          "optional": true
        },
        "spaceIdOrSlug": {
          "kind": "string",
          "optional": true
        },
        "summary": {
          "kind": "string",
          "optional": true
        },
        "threadId": {
          "kind": "string",
          "optional": true
        },
        "title": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "mutating_write",
      "surfaces": [
        "thread"
      ],
      "visibility": "surface-scoped"
    },
    "tools.executeCode": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "actions",
      "description": "Execute ephemeral per-turn agent-written JavaScript through the 0000 Code Mode runtime. Use for loops, conditions, pagination, transforms, retries, and branching that are too dynamic for tools.executePlan. Code may call scoped 0000 tools through the provided tools helper; server-side auth, approval, audit, tool policy, limits, and scoped credentials remain enforced by the broker.",
      "effect": "row_write",
      "executionMode": "mutation",
      "featureFlagKey": "actions-runtime",
      "inputSchema": {
        "code": {
          "kind": "string",
          "sensitive": true
        },
        "input": {
          "kind": "record",
          "optional": true,
          "value": {
            "kind": "unknown"
          }
        }
      },
      "risk": "mutating_write",
      "sensitiveInput": true,
      "surfaces": [
        "action",
        "settings"
      ],
      "visibility": "surface-scoped"
    },
    "userPrompts.requestChoice": {
      "annotations": {
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
        "readOnlyHint": false
      },
      "approvalBehavior": "approval_gated_write",
      "capabilityPack": "threads",
      "description": "Ask the user one or more structured questions in the current 0000 Chat thread. Supports single-choice, checkbox multi-select, text answers, custom answers, and multi-question batched submission. Use this instead of printing a lettered list when you need the multiple-choice UI and decision-needed thread indicator.",
      "effect": "interaction_write",
      "executionMode": "mutation",
      "inputSchema": {
        "allowCustomResponse": {
          "kind": "boolean",
          "optional": true
        },
        "choices": {
          "items": {
            "fields": {
              "description": {
                "kind": "string",
                "optional": true
              },
              "id": {
                "kind": "string"
              },
              "label": {
                "kind": "string"
              }
            },
            "kind": "object"
          },
          "kind": "array",
          "optional": true
        },
        "customResponseLabel": {
          "kind": "string",
          "optional": true
        },
        "prompt": {
          "kind": "string",
          "optional": true
        },
        "questions": {
          "items": {
            "fields": {
              "allowCustomResponse": {
                "kind": "boolean",
                "optional": true
              },
              "choices": {
                "items": {
                  "fields": {
                    "description": {
                      "kind": "string",
                      "optional": true
                    },
                    "id": {
                      "kind": "string"
                    },
                    "label": {
                      "kind": "string"
                    }
                  },
                  "kind": "object"
                },
                "kind": "array",
                "optional": true
              },
              "customResponseLabel": {
                "kind": "string",
                "optional": true
              },
              "description": {
                "kind": "string",
                "optional": true
              },
              "id": {
                "kind": "string"
              },
              "prompt": {
                "kind": "string"
              },
              "required": {
                "kind": "boolean",
                "optional": true
              },
              "responseKind": {
                "kind": "enum",
                "optional": true,
                "values": [
                  "choice",
                  "text"
                ]
              },
              "selectionMode": {
                "kind": "enum",
                "optional": true,
                "values": [
                  "single",
                  "multiple"
                ]
              }
            },
            "kind": "object"
          },
          "kind": "array",
          "optional": true
        },
        "selectionMode": {
          "kind": "enum",
          "optional": true,
          "values": [
            "single",
            "multiple"
          ]
        },
        "title": {
          "kind": "string",
          "optional": true
        }
      },
      "risk": "user_interaction",
      "visibility": "core"
    }
  },
  "AGENT_TOOL_MANIFEST_NAMES": [
    "capabilities.describe",
    "capabilities.advise",
    "context.get",
    "userPrompts.requestChoice",
    "objects.get",
    "objects.search",
    "objects.listLinked",
    "threads.current",
    "runtime.readEvidence",
    "threads.readActivity",
    "threads.contextList",
    "threads.contextDescribe",
    "threads.contextExpand",
    "threads.list",
    "threads.read",
    "threads.update",
    "threads.create",
    "threads.createChild",
    "threads.listChildren",
    "threads.listDescendants",
    "threads.listChildrenByTags",
    "threads.continue",
    "threads.fork",
    "messages.search",
    "tags.list",
    "tags.create",
    "tags.update",
    "tags.archive",
    "tags.listForTarget",
    "tags.assign",
    "tags.unassign",
    "settings.setDefaultApprovalLevel",
    "agents.list",
    "agents.sendMailboxMessage",
    "spaces.list",
    "spaces.get",
    "spaces.create",
    "spaces.update",
    "spaces.archive",
    "spaces.unarchive",
    "apps.list",
    "apps.get",
    "apps.create",
    "apps.createRevision",
    "apps.generateFromRevision",
    "apps.listGenerations",
    "apps.update",
    "apps.archive",
    "apps.validateOpenUi",
    "apps.code.describeRuntime",
    "apps.code.create",
    "apps.code.startEdit",
    "apps.code.listFiles",
    "apps.code.readFiles",
    "apps.code.reserveSource",
    "apps.code.completeSource",
    "apps.code.putFiles",
    "apps.code.checkProject",
    "apps.code.readCheck",
    "apps.code.publishRevision",
    "apps.code.discardEdit",
    "apps.code.disable",
    "apps.code.rollback",
    "automations.list",
    "automations.get",
    "automations.create",
    "automations.update",
    "automations.disable",
    "automations.runNow",
    "databases.list",
    "databases.get",
    "databases.listFieldOptions",
    "databases.create",
    "databases.createField",
    "databases.deleteField",
    "databases.listRows",
    "databases.getRow",
    "databases.searchRows",
    "databases.createRow",
    "databases.updateRow",
    "databases.deleteRow",
    "databases.listRelationshipDefinitions",
    "databases.listRowRelationships",
    "databases.createRelationshipDefinition",
    "databases.deleteRelationshipDefinition",
    "databases.createRelationship",
    "databases.deleteRelationship",
    "databases.delete",
    "databaseViews.list",
    "databaseViews.get",
    "databaseViews.getDefault",
    "databaseViews.create",
    "databaseViews.updateConfig",
    "databaseViews.rename",
    "databaseViews.duplicate",
    "databaseViews.setDefault",
    "databaseViews.delete",
    "secrets.put",
    "secrets.requestCollection",
    "secrets.listAvailable",
    "artifacts.create",
    "artifacts.createUploadIntent",
    "artifacts.completeUpload",
    "artifacts.search",
    "artifacts.read",
    "artifacts.readContent",
    "artifacts.getContentUrl",
    "artifacts.update",
    "artifacts.patchText",
    "artifacts.link",
    "bridgeDevices.list",
    "machineEnrollments.listActive",
    "machineEnrollments.create",
    "machineEnrollments.regenerate",
    "bridgeDevices.revoke",
    "bridgeDevices.delete",
    "bridgeDevices.renameLocation",
    "bridgeDevices.refreshHermesProfiles",
    "bridgeDevices.requestUpdateWhenIdle",
    "bridgeDevices.requestRestartWhenIdle",
    "bridgeDevices.cancelPendingControl",
    "notifications.getBrowserConfig",
    "notifications.getBrowserSubscriptionStatus",
    "notifications.getNativeDeviceStatus",
    "notifications.subscribeBrowser",
    "notifications.registerNativeDevice",
    "notifications.unregisterNativeDevice",
    "notifications.unsubscribeBrowser",
    "actions.createDraft",
    "actions.updateDraft",
    "actions.archive",
    "actions.search",
    "actions.read",
    "tools.executeCode",
    "actions.run"
  ]
}) as const
