import { createHash, createPublicKey, verify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { bindFinancialDatabaseScope } from '../shared/database-scope.js';
import type { TrustedScope } from '../shared/contracts.js';
import type { ReportingTransactionPort } from './runtime.js';

// Closed local Finance-owned records; no deployed registry or canonical SDK adoption.
const RECORD_SCHEMA: JsonSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "ci-finance-partition-local-records-1.0.0/source-design",
  "$defs": {
    "Reference": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "contentHash": {
          "type": "string",
          "pattern": "^sha256:[a-f0-9]{64}$"
        }
      },
      "required": [
        "id",
        "revision",
        "contentHash"
      ],
      "additionalProperties": false
    },
    "Scope": {
      "type": "object",
      "properties": {
        "tenantId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "projectId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "actorId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "environment": {
          "enum": [
            "development",
            "test",
            "production"
          ]
        },
        "billingMode": {
          "enum": [
            "live",
            "sandbox",
            "simulated"
          ]
        }
      },
      "required": [
        "tenantId",
        "projectId",
        "actorId",
        "environment",
        "billingMode"
      ],
      "additionalProperties": false
    },
    "Partition": {
      "type": "object",
      "properties": {
        "tenantId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "projectId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "environment": {
          "enum": [
            "development",
            "test",
            "production"
          ]
        },
        "billingMode": {
          "enum": [
            "live",
            "sandbox",
            "simulated"
          ]
        }
      },
      "required": [
        "tenantId",
        "projectId",
        "environment",
        "billingMode"
      ],
      "additionalProperties": false
    },
    "IssuerKeyReference": {
      "type": "object",
      "properties": {
        "registryReference": {
          "$ref": "#/$defs/Reference"
        },
        "keyId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "publicKeyContentHash": {
          "type": "string",
          "pattern": "^sha256:[a-f0-9]{64}$"
        }
      },
      "required": [
        "registryReference",
        "keyId",
        "revision",
        "publicKeyContentHash"
      ],
      "additionalProperties": false
    },
    "CustodyReferences": {
      "type": "object",
      "properties": {
        "session": {
          "$ref": "#/$defs/Reference"
        },
        "account": {
          "$ref": "#/$defs/Reference"
        },
        "event": {
          "$ref": "#/$defs/Reference"
        },
        "issuer": {
          "$ref": "#/$defs/Reference"
        },
        "policy": {
          "$ref": "#/$defs/Reference"
        }
      },
      "required": [
        "session",
        "account",
        "event",
        "issuer",
        "policy"
      ],
      "additionalProperties": false
    },
    "Signature": {
      "type": "object",
      "properties": {
        "algorithm": {
          "const": "Ed25519"
        },
        "value": {
          "type": "string",
          "pattern": "^[A-Za-z0-9_-]{86}$"
        }
      },
      "required": [
        "algorithm",
        "value"
      ],
      "additionalProperties": false
    },
    "BindingUnsigned": {
      "type": "object",
      "properties": {
        "format": {
          "const": "ci-finance-ledger-partition-binding-1.0.0"
        },
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "state": {
          "enum": [
            "active",
            "revoked"
          ]
        },
        "issuerId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "issuerRegistryReference": {
          "$ref": "#/$defs/Reference"
        },
        "issuerKeyReference": {
          "$ref": "#/$defs/IssuerKeyReference"
        },
        "issuerEntitlementReference": {
          "$ref": "#/$defs/Reference"
        },
        "maintainerAccountRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "maintainerSessionRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "sourceTenantId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "sourceProjectRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        },
        "partition": {
          "$ref": "#/$defs/Partition"
        },
        "ledgerBackendReference": {
          "$ref": "#/$defs/Reference"
        },
        "policyReference": {
          "$ref": "#/$defs/Reference"
        },
        "issuerConfigurationReference": {
          "$ref": "#/$defs/Reference"
        },
        "sourceCustodyReferences": {
          "$ref": "#/$defs/CustodyReferences"
        },
        "notBefore": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
        },
        "issuedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
        },
        "revocationRevision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "sourceLineageReferences": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Reference"
          },
          "minItems": 1,
          "maxItems": 16,
          "uniqueItems": true
        }
      },
      "required": [
        "format",
        "id",
        "revision",
        "state",
        "issuerId",
        "issuerRegistryReference",
        "issuerKeyReference",
        "issuerEntitlementReference",
        "maintainerAccountRef",
        "maintainerSessionRef",
        "sourceTenantId",
        "sourceProjectRef",
        "scope",
        "partition",
        "ledgerBackendReference",
        "policyReference",
        "issuerConfigurationReference",
        "sourceCustodyReferences",
        "notBefore",
        "issuedAt",
        "expiresAt",
        "revocationRevision",
        "sourceLineageReferences"
      ],
      "additionalProperties": false
    },
    "LineageUnsigned": {
      "type": "object",
      "properties": {
        "format": {
          "const": "ci-finance-partition-source-lineage-1.0.0"
        },
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "state": {
          "enum": [
            "active",
            "revoked"
          ]
        },
        "issuerId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "issuerRegistryReference": {
          "$ref": "#/$defs/Reference"
        },
        "issuerKeyReference": {
          "$ref": "#/$defs/IssuerKeyReference"
        },
        "issuerEntitlementReference": {
          "$ref": "#/$defs/Reference"
        },
        "maintainerAccountRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "maintainerSessionRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "sourceTenantId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "sourceProjectRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        },
        "partition": {
          "$ref": "#/$defs/Partition"
        },
        "ledgerBackendReference": {
          "$ref": "#/$defs/Reference"
        },
        "policyReference": {
          "$ref": "#/$defs/Reference"
        },
        "issuerConfigurationReference": {
          "$ref": "#/$defs/Reference"
        },
        "sourceCustodyReferences": {
          "$ref": "#/$defs/CustodyReferences"
        },
        "notBefore": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
        },
        "issuedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
        },
        "revocationRevision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "sourceIdentity": {
          "type": "object",
          "properties": {
            "sourceName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "sourceObjectId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "revisionSubjectId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            }
          },
          "required": [
            "sourceName",
            "sourceObjectId",
            "revisionSubjectId"
          ],
          "additionalProperties": false
        },
        "rootEvent": {
          "type": "object",
          "properties": {
            "eventId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "eventHash": {
              "type": "string",
              "pattern": "^sha256:[a-f0-9]{64}$"
            }
          },
          "required": [
            "eventId",
            "eventHash"
          ],
          "additionalProperties": false
        },
        "currentHead": {
          "type": "object",
          "properties": {
            "eventId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "eventHash": {
              "type": "string",
              "pattern": "^sha256:[a-f0-9]{64}$"
            },
            "revisionSequence": {
              "type": "integer",
              "minimum": 0,
              "maximum": 2147483647
            }
          },
          "required": [
            "eventId",
            "eventHash",
            "revisionSequence"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "format",
        "id",
        "revision",
        "state",
        "issuerId",
        "issuerRegistryReference",
        "issuerKeyReference",
        "issuerEntitlementReference",
        "maintainerAccountRef",
        "maintainerSessionRef",
        "sourceTenantId",
        "sourceProjectRef",
        "scope",
        "partition",
        "ledgerBackendReference",
        "policyReference",
        "issuerConfigurationReference",
        "sourceCustodyReferences",
        "notBefore",
        "issuedAt",
        "expiresAt",
        "revocationRevision",
        "sourceIdentity",
        "rootEvent",
        "currentHead"
      ],
      "additionalProperties": false
    },
    "BindingEnvelope": {
      "type": "object",
      "properties": {
        "unsigned": {
          "$ref": "#/$defs/BindingUnsigned"
        },
        "signature": {
          "$ref": "#/$defs/Signature"
        }
      },
      "required": [
        "unsigned",
        "signature"
      ],
      "additionalProperties": false
    },
    "LineageEnvelope": {
      "type": "object",
      "properties": {
        "unsigned": {
          "$ref": "#/$defs/LineageUnsigned"
        },
        "signature": {
          "$ref": "#/$defs/Signature"
        }
      },
      "required": [
        "unsigned",
        "signature"
      ],
      "additionalProperties": false
    },
    "IssuerKeyRecord": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "state": {
          "enum": [
            "active",
            "revoked"
          ]
        },
        "issuerId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "registryId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "registryRevision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "publicKeySpkiBase64url": {
          "type": "string",
          "pattern": "^[A-Za-z0-9_-]{59}$"
        },
        "publicKeyContentHash": {
          "type": "string",
          "pattern": "^sha256:[a-f0-9]{64}$"
        },
        "allowedRecordKinds": {
          "type": "array",
          "items": {
            "enum": [
              "ci-finance-ledger-partition-binding-1.0.0",
              "ci-finance-partition-source-lineage-1.0.0",
              "ci-finance-maintainer-action-1.0.0"
            ]
          },
          "minItems": 1,
          "maxItems": 3,
          "uniqueItems": true
        },
        "allowedActions": {
          "type": "array",
          "items": {
            "enum": [
              "bindPartition",
              "registerSourceLineage",
              "provisionMapping",
              "reviseMapping",
              "revokeMapping"
            ]
          },
          "minItems": 1,
          "maxItems": 5,
          "uniqueItems": true
        },
        "allowedScopes": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Scope"
          },
          "minItems": 1,
          "maxItems": 32,
          "uniqueItems": true
        },
        "entitlementReferences": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Reference"
          },
          "minItems": 1,
          "maxItems": 32,
          "uniqueItems": true
        },
        "notBefore": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
        },
        "custodyEpoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "id",
        "revision",
        "state",
        "issuerId",
        "registryId",
        "registryRevision",
        "publicKeySpkiBase64url",
        "publicKeyContentHash",
        "allowedRecordKinds",
        "allowedActions",
        "allowedScopes",
        "entitlementReferences",
        "notBefore",
        "expiresAt",
        "custodyEpoch"
      ],
      "additionalProperties": false
    },
    "IssuerEntitlementRecord": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "state": {
          "enum": [
            "active",
            "revoked"
          ]
        },
        "issuerId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "registryId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "registryRevision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "accountRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "sessionRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "allowedRecordKinds": {
          "type": "array",
          "items": {
            "enum": [
              "ci-finance-ledger-partition-binding-1.0.0",
              "ci-finance-partition-source-lineage-1.0.0",
              "ci-finance-maintainer-action-1.0.0"
            ]
          },
          "minItems": 1,
          "maxItems": 3,
          "uniqueItems": true
        },
        "allowedActions": {
          "type": "array",
          "items": {
            "enum": [
              "bindPartition",
              "registerSourceLineage",
              "provisionMapping",
              "reviseMapping",
              "revokeMapping"
            ]
          },
          "minItems": 1,
          "maxItems": 5,
          "uniqueItems": true
        },
        "allowedScopes": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Scope"
          },
          "minItems": 1,
          "maxItems": 32,
          "uniqueItems": true
        },
        "sourceTenantId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "sourceProjectRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "policyReference": {
          "$ref": "#/$defs/Reference"
        },
        "issuerConfigurationReference": {
          "$ref": "#/$defs/Reference"
        },
        "ledgerBackendReference": {
          "$ref": "#/$defs/Reference"
        },
        "notBefore": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
        },
        "custodyEpoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "id",
        "revision",
        "state",
        "issuerId",
        "registryId",
        "registryRevision",
        "accountRef",
        "sessionRef",
        "allowedRecordKinds",
        "allowedActions",
        "allowedScopes",
        "sourceTenantId",
        "sourceProjectRef",
        "policyReference",
        "issuerConfigurationReference",
        "ledgerBackendReference",
        "notBefore",
        "expiresAt",
        "custodyEpoch"
      ],
      "additionalProperties": false
    },
    "PrincipalSessionRecord": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "state": {
          "enum": [
            "active",
            "revoked"
          ]
        },
        "accountRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "sessionRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        },
        "notBefore": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
        },
        "custodyEpoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "id",
        "revision",
        "state",
        "accountRef",
        "sessionRef",
        "scope",
        "notBefore",
        "expiresAt",
        "custodyEpoch"
      ],
      "additionalProperties": false
    },
    "MaintainedSignedRecordHead": {
      "type": "object",
      "properties": {
        "recordReference": {
          "$ref": "#/$defs/Reference"
        },
        "signedRecordContentHash": {
          "type": "string",
          "pattern": "^sha256:[a-f0-9]{64}$"
        },
        "state": {
          "enum": [
            "active",
            "revoked",
            "changing"
          ]
        },
        "custodyEpoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "recordReference",
        "signedRecordContentHash",
        "state",
        "custodyEpoch"
      ],
      "additionalProperties": false
    },
    "IssuerRegistryRecord": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "state": {
          "enum": [
            "active",
            "revoked"
          ]
        },
        "verifierId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "keys": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/IssuerKeyRecord"
          },
          "minItems": 1,
          "maxItems": 32,
          "uniqueItems": true
        },
        "entitlements": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/IssuerEntitlementRecord"
          },
          "minItems": 1,
          "maxItems": 32,
          "uniqueItems": true
        }
      },
      "required": [
        "id",
        "revision",
        "state",
        "verifierId",
        "keys",
        "entitlements"
      ],
      "additionalProperties": false
    }
  },
  "oneOf": [
    {
      "$ref": "#/$defs/BindingEnvelope"
    },
    {
      "$ref": "#/$defs/LineageEnvelope"
    }
  ],
  "description": "Closed local design only. Native Ed25519 semantic/currentness admission is separate; these schemas create no live issuer, deployed registry or privilege."
};
const ACTION_SCHEMA: JsonSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "ci-finance-maintainer-action-1.0.0/source-design",
  "title": "Closed signed maintainer action source design; not admitted live records",
  "$defs": {
    "Reference": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "contentHash": {
          "type": "string",
          "pattern": "^sha256:[a-f0-9]{64}$"
        }
      },
      "required": [
        "id",
        "revision",
        "contentHash"
      ],
      "additionalProperties": false
    },
    "Scope": {
      "type": "object",
      "properties": {
        "tenantId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "projectId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "actorId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "environment": {
          "enum": [
            "development",
            "test",
            "production"
          ]
        },
        "billingMode": {
          "enum": [
            "live",
            "sandbox",
            "simulated"
          ]
        }
      },
      "required": [
        "tenantId",
        "projectId",
        "actorId",
        "environment",
        "billingMode"
      ],
      "additionalProperties": false
    },
    "Partition": {
      "type": "object",
      "properties": {
        "tenantId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "projectId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "environment": {
          "enum": [
            "development",
            "test",
            "production"
          ]
        },
        "billingMode": {
          "enum": [
            "live",
            "sandbox",
            "simulated"
          ]
        }
      },
      "required": [
        "tenantId",
        "projectId",
        "environment",
        "billingMode"
      ],
      "additionalProperties": false
    },
    "Mapping": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "state": {
          "enum": [
            "active",
            "revoked"
          ]
        },
        "sourceIssuer": {
          "const": "getticketstub.com"
        },
        "sourceAudience": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "sourceTenantId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "sourceProjectRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        },
        "ledgerPartition": {
          "$ref": "#/$defs/Partition"
        },
        "policyReference": {
          "$ref": "#/$defs/Reference"
        },
        "issuerConfigurationReference": {
          "$ref": "#/$defs/Reference"
        },
        "financeBindingReference": {
          "$ref": "#/$defs/Reference"
        },
        "sourceCustodyReferences": {
          "type": "object",
          "properties": {
            "session": {
              "$ref": "#/$defs/Reference"
            },
            "account": {
              "$ref": "#/$defs/Reference"
            },
            "event": {
              "$ref": "#/$defs/Reference"
            },
            "issuer": {
              "$ref": "#/$defs/Reference"
            },
            "policy": {
              "$ref": "#/$defs/Reference"
            }
          },
          "required": [
            "session",
            "account",
            "event",
            "issuer",
            "policy"
          ],
          "additionalProperties": false
        },
        "operationRecords": {
          "type": "object",
          "properties": {
            "read": {
              "type": "object",
              "properties": {
                "action": {
                  "const": "finance.read"
                },
                "operation": {
                  "const": "reporting.querySummary"
                },
                "permission": {
                  "const": "finance.summary.read"
                },
                "state": {
                  "enum": [
                    "active",
                    "revoked"
                  ]
                },
                "revision": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "authorityReference": {
                  "$ref": "#/$defs/Reference"
                }
              },
              "required": [
                "action",
                "operation",
                "permission",
                "state",
                "revision",
                "authorityReference"
              ],
              "additionalProperties": false
            },
            "export": {
              "type": "object",
              "properties": {
                "action": {
                  "const": "finance.export"
                },
                "operation": {
                  "const": "integrations.exportSummary"
                },
                "permission": {
                  "const": "finance.summary.export"
                },
                "state": {
                  "enum": [
                    "active",
                    "revoked"
                  ]
                },
                "revision": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "authorityReference": {
                  "$ref": "#/$defs/Reference"
                }
              },
              "required": [
                "action",
                "operation",
                "permission",
                "state",
                "revision",
                "authorityReference"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "read",
            "export"
          ],
          "additionalProperties": false
        },
        "verifiedAt": {
          "type": "string",
          "format": "date-time"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time"
        },
        "governanceAction": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "revision": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "id",
            "revision"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "id",
        "revision",
        "state",
        "sourceIssuer",
        "sourceAudience",
        "sourceTenantId",
        "sourceProjectRef",
        "scope",
        "ledgerPartition",
        "policyReference",
        "issuerConfigurationReference",
        "financeBindingReference",
        "sourceCustodyReferences",
        "operationRecords",
        "verifiedAt",
        "expiresAt",
        "governanceAction"
      ],
      "additionalProperties": false
    },
    "Prior": {
      "type": "object",
      "properties": {
        "state": {
          "enum": [
            "absent",
            "active",
            "revoked"
          ]
        },
        "revision": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "contentHash": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^sha256:[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "custodyEpoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "state",
        "revision",
        "contentHash",
        "custodyEpoch"
      ],
      "additionalProperties": false
    },
    "UnsignedAction": {
      "type": "object",
      "properties": {
        "format": {
          "const": "ci-finance-maintainer-action-1.0.0"
        },
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "action": {
          "enum": [
            "provisionMapping",
            "reviseMapping",
            "revokeMapping"
          ]
        },
        "target": {
          "type": "object",
          "properties": {
            "kind": {
              "const": "finance_scope_mapping"
            },
            "mappingId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "hostConfigurationReference": {
              "$ref": "#/$defs/Reference"
            }
          },
          "required": [
            "kind",
            "mappingId",
            "hostConfigurationReference"
          ],
          "additionalProperties": false
        },
        "audience": {
          "type": "object",
          "properties": {
            "verifierId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "financeBackendReference": {
              "$ref": "#/$defs/Reference"
            },
            "issuerRegistryReference": {
              "$ref": "#/$defs/Reference"
            }
          },
          "required": [
            "verifierId",
            "financeBackendReference",
            "issuerRegistryReference"
          ],
          "additionalProperties": false
        },
        "operator": {
          "type": "object",
          "properties": {
            "accountRef": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "sessionRef": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            }
          },
          "required": [
            "accountRef",
            "sessionRef"
          ],
          "additionalProperties": false
        },
        "sourceTenantId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "sourceProjectRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "scope": {
          "$ref": "#/$defs/Scope"
        },
        "expectedPrior": {
          "$ref": "#/$defs/Prior"
        },
        "change": {
          "type": "object",
          "properties": {
            "mapping": {
              "$ref": "#/$defs/Mapping"
            }
          },
          "required": [
            "mapping"
          ],
          "additionalProperties": false
        },
        "changeContentHash": {
          "type": "string",
          "pattern": "^sha256:[a-f0-9]{64}$"
        },
        "policyReference": {
          "$ref": "#/$defs/Reference"
        },
        "issuerKeyReference": {
          "type": "object",
          "properties": {
            "registryReference": {
              "$ref": "#/$defs/Reference"
            },
            "keyId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "revision": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "publicKeyContentHash": {
              "type": "string",
              "pattern": "^sha256:[a-f0-9]{64}$"
            }
          },
          "required": [
            "registryReference",
            "keyId",
            "revision",
            "publicKeyContentHash"
          ],
          "additionalProperties": false
        },
        "entitlementReference": {
          "$ref": "#/$defs/Reference"
        },
        "financeBindingReference": {
          "$ref": "#/$defs/Reference"
        },
        "notBefore": {
          "type": "string",
          "format": "date-time"
        },
        "issuedAt": {
          "type": "string",
          "format": "date-time"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "format",
        "id",
        "revision",
        "action",
        "target",
        "audience",
        "operator",
        "sourceTenantId",
        "sourceProjectRef",
        "scope",
        "expectedPrior",
        "change",
        "changeContentHash",
        "policyReference",
        "issuerKeyReference",
        "entitlementReference",
        "financeBindingReference",
        "notBefore",
        "issuedAt",
        "expiresAt"
      ],
      "additionalProperties": false
    }
  },
  "type": "object",
  "properties": {
    "unsigned": {
      "$ref": "#/$defs/UnsignedAction"
    },
    "signature": {
      "type": "object",
      "properties": {
        "algorithm": {
          "const": "Ed25519"
        },
        "value": {
          "type": "string",
          "pattern": "^[A-Za-z0-9_-]{86}$"
        }
      },
      "required": [
        "algorithm",
        "value"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "unsigned",
    "signature"
  ],
  "additionalProperties": false
};

type JsonSchema = { $ref?: string; $defs?: Record<string, JsonSchema>; anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; type?: string; const?: unknown; enum?: unknown[]; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean; items?: JsonSchema; minItems?: number; maxItems?: number; uniqueItems?: boolean; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; format?: string; [key: string]: unknown };
type RecordData = Record<string, any>;
export interface FinanceBindingReference { id: string; revision: number; contentHash: string }
export interface FinanceBindingRequest { sourceTenantId: string; sourceProjectRef: string; scope: TrustedScope; bindingReference: FinanceBindingReference; policyReference: FinanceBindingReference }
export interface FinanceBindingMutationFrame { format: 'ci-finance-binding-mutation-frame-1.0.0'; signedMaintainerActionCanonicalBytes: string }
export type FinanceBindingRefusalReason = 'clock_changed' | 'current_action_changed' | 'invalid_validity' | 'action_mismatch' | 'ambiguous_lineage' | 'authority_changed' | 'authority_mismatch' | 'backend_mismatch' | 'backend_unavailable' | 'binding_mismatch' | 'clock_unavailable' | 'current_source_changed' | 'custody_absent' | 'custody_busy' | 'custody_changed' | 'duplicate_field' | 'entitlement_not_admitted' | 'expired' | 'foreign_or_ended_guard' | 'foreign_or_ended_handle' | 'frame_mismatch' | 'handle_not_ready' | 'invalid_action' | 'invalid_encoding' | 'invalid_frame' | 'invalid_json' | 'invalid_number' | 'invalid_owned_record' | 'invalid_request' | 'invalid_signature' | 'invalid_signed_record' | 'invalid_structure' | 'issuer_not_admitted' | 'lineage_mismatch' | 'noncanonical_bytes' | 'partition_source_absent' | 'principal_mismatch' | 'prior_mismatch' | 'reentrant_operation' | 'registry_changed' | 'resource_limit' | 'revoked' | 'scope_mismatch' | 'source_absent' | 'source_changing' | 'source_unavailable' | 'unconfigured' | 'unsupported_custody' | 'unsupported_schema';
export type FinanceBindingRefusal = { status: 'denied' | 'unavailable'; reason: FinanceBindingRefusalReason };
export type FinanceBindingObservation = { status: 'verified'; bindingReference: FinanceBindingReference; policyReference: FinanceBindingReference; scope: TrustedScope; sourceTenantId: string; sourceProjectRef: string; ledgerBackendReference: FinanceBindingReference; sourceLineageReferences: FinanceBindingReference[]; currentEpochCommitment: string; verifiedAt: string; expiresAt: string; provenance: 'isolated_fixture' };
export interface FinanceLedgerPartitionBindingPort { verifyCurrentBinding(request: FinanceBindingRequest): Promise<FinanceBindingObservation | FinanceBindingRefusal> }
export interface FinancePrivateBindingHandle { readonly kind: 'finance_private_binding_handle' }
export interface FinancePrivateTransactionGuard { readonly kind: 'finance_private_transaction_guard' }
export interface FinanceOwnedBindingCurrentnessPort {
  prepareCurrentness(guard: FinancePrivateTransactionGuard, request: FinanceBindingRequest, frame: FinanceBindingMutationFrame): Promise<{ status: 'ready'; privateBindingHandle: FinancePrivateBindingHandle } | FinanceBindingRefusal>;
  validateCurrent(handle: FinancePrivateBindingHandle, frame: FinanceBindingMutationFrame): { status: 'current' } | FinanceBindingRefusal;
}
/** Private owner composition only. These operations control a transaction, never accept SQL or provision mappings. */
export interface FinanceBindingGuardLifecyclePort {
  acquireGuard(frame: FinanceBindingMutationFrame): { status: 'held'; guard: FinancePrivateTransactionGuard } | FinanceBindingRefusal;
  commitGuard(guard: FinancePrivateTransactionGuard): { status: 'committed' } | { status: 'indeterminate' } | FinanceBindingRefusal;
  rollbackGuard(guard: FinancePrivateTransactionGuard): { status: 'rolled_back' } | FinanceBindingRefusal;
  destroy(): void;
}
export interface FinanceBindingCustodySource { readonly kind: 'finance_sqlite_custody_source' }
export interface FinanceBindingConfiguration {
  custodySource: FinanceBindingCustodySource;
  /** Independently host-selected actual pool; never taken from a binding/request. */
  selectedBackend: { reference: FinanceBindingReference; databaseName: string; database: { connect(): Promise<ReportingTransactionPort> } };
  clock: { now(): Date };
}
class BindingFailure extends Error { constructor(readonly status: 'denied' | 'unavailable', readonly reason: FinanceBindingRefusalReason) { super(reason); } }
function refuse(status: 'denied' | 'unavailable', reason: FinanceBindingRefusalReason): never { throw new BindingFailure(status, reason); }
const resultOf = (error: unknown): FinanceBindingRefusal => error instanceof BindingFailure ? { status: error.status, reason: error.reason } : { status: 'unavailable', reason: 'source_unavailable' };
const encoder = new TextEncoder();
const digest = (bytes: string | Uint8Array) => 'sha256:' + createHash('sha256',{}).update(typeof bytes === 'string' ? encoder.encode(bytes) : bytes).digest('hex');

/** One bounded, closed canonical domain for local authority records, not an SDK financial hash alias. */
export function financeBindingCanonicalBytes(value: unknown): string {
  let nodes = 0;
  function normalized(v: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 32) refuse('denied','invalid_structure');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') { if (!Number.isSafeInteger(v)) refuse('denied','invalid_number'); return v; }
    if (typeof v !== 'object' || types.isProxy(v)) refuse('denied','invalid_structure');
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).some(k => k !== 'length' && (typeof k !== 'string' || !/^(0|[1-9]\d*)$/.test(k) || Number(k) >= v.length))
        || Array.from({length:v.length},(_,i)=>descriptors[String(i)]).some(d => !d || !('value' in d))) refuse('denied','invalid_structure');
      return v.map(x=>normalized(x,depth+1));
    }
    if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).some(k => typeof k !== 'string' || !descriptors[k]?.enumerable || !('value' in descriptors[k]!))) refuse('denied','invalid_structure');
    return Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalized(descriptors[k]!.value,depth+1)]));
  }
  const bytes = JSON.stringify(normalized(value,0));
  if (encoder.encode(bytes).length > 2097152) refuse('denied','resource_limit');
  return bytes;
}
const contentHash = (value: unknown) => digest(financeBindingCanonicalBytes(value));
const equal = (a: unknown,b: unknown) => financeBindingCanonicalBytes(a) === financeBindingCanonicalBytes(b);
function freeze<T>(value:T):T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function financeBindingRecordSchemas() { return freeze(JSON.parse(JSON.stringify({records:RECORD_SCHEMA,action:ACTION_SCHEMA}))); }
function check(schema:JsonSchema,value:unknown,root:JsonSchema):boolean {
  if (schema.$ref) { const target=root.$defs?.[schema.$ref.split('/').at(-1)!]; return !!target && check(target,value,root); }
  if (schema.anyOf) return schema.anyOf.some(x=>check(x,value,root));
  if (schema.oneOf) return schema.oneOf.filter(x=>check(x,value,root)).length===1;
  if (Object.hasOwn(schema,'const') && !equal(schema.const,value)) return false;
  if (schema.enum && !schema.enum.some(x=>equal(x,value))) return false;
  if (schema.type==='object') {
    if (!value || typeof value!=='object' || Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value)!==Object.prototype) return false;
    const o=value as Record<string,unknown>,descs=Object.getOwnPropertyDescriptors(o);
    if (Reflect.ownKeys(o).some(k=>typeof k!=='string'||!descs[k]?.enumerable||!('value'in descs[k]!))) return false;
    if (schema.required?.some(k=>!Object.hasOwn(o,k)) || (schema.additionalProperties===false && Object.keys(o).some(k=>!Object.hasOwn(schema.properties??{},k)))) return false;
    return Object.entries(schema.properties??{}).every(([k,s])=>!Object.hasOwn(o,k)||check(s,o[k],root));
  }
  if (schema.type==='array') return Array.isArray(value) && value.length>=(schema.minItems??0) && value.length<=(schema.maxItems??Infinity) && value.every(x=>!!schema.items&&check(schema.items,x,root)) && (!schema.uniqueItems||new Set(value.map(financeBindingCanonicalBytes)).size===value.length);
  if (schema.type==='integer') return typeof value==='number'&&Number.isSafeInteger(value)&&value>=(schema.minimum??-Infinity)&&value<=(schema.maximum??Infinity);
  if (schema.type==='string') return typeof value==='string'&&value.length>=(schema.minLength??0)&&value.length<=(schema.maxLength??Infinity)&&(!schema.pattern||new RegExp(schema.pattern).test(value))&&(!schema.format||schema.format!=='date-time'||(Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value));
  if (schema.type==='null') return value===null;
  return true;
}
/** Reject duplicate keys before JSON.parse; no parsing coercions or ignored signed fields. */
function parseClosed(text:string,maxBytes=65536):RecordData {
  if (typeof text!=='string'||encoder.encode(text).length>maxBytes) refuse('denied','resource_limit');
  let pos=0,nodes=0;
  const ws=()=>{while(pos<text.length&&/\s/.test(text[pos]!))pos++;};
  const string=()=>{const start=pos++;while(pos<text.length){const c=text[pos++];if(c==='\\'){pos++;continue;}if(c==='"')return JSON.parse(text.slice(start,pos)) as string;}return refuse('denied','invalid_json');};
  function item(depth:number):void {
    if (++nodes>100000||depth>32) refuse('denied','resource_limit'); ws();
    if (text[pos]==='{') {pos++;ws();const keys=new Set<string>();if(text[pos]==='}'){pos++;return;}for(;;){ws();if(text[pos]!=='"')refuse('denied','invalid_json');const k=string();if(keys.has(k))refuse('denied','duplicate_field');keys.add(k);ws();if(text[pos++]!==':')refuse('denied','invalid_json');item(depth+1);ws();const c=text[pos++];if(c==='}')return;if(c!==',')refuse('denied','invalid_json');}}
    if (text[pos]==='[') {pos++;ws();if(text[pos]===']'){pos++;return;}for(;;){item(depth+1);ws();const c=text[pos++];if(c===']')return;if(c!==',')refuse('denied','invalid_json');}}
    if (text[pos]==='"'){string();return;}
    const token=text.slice(pos).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);if(!token)refuse('denied','invalid_json');pos+=token[0].length;
  }
  item(0);ws();if(pos!==text.length)refuse('denied','invalid_json');
  const value=JSON.parse(text);if (financeBindingCanonicalBytes(value)!==text)refuse('denied','noncanonical_bytes');return value;
}
function b64(text:string,size:number):Uint8Array {
  if(!/^[A-Za-z0-9_-]+$/.test(text))refuse('denied','invalid_encoding');
  const raw=atob(text.replaceAll('-','+').replaceAll('_','/'));const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  if(bytes.length!==size||btoa(raw).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')!==text)refuse('denied','invalid_encoding');return bytes;
}
function closedRequest(input:FinanceBindingRequest):FinanceBindingRequest {
  const copy=JSON.parse(financeBindingCanonicalBytes(input));const def=RECORD_SCHEMA.$defs!;
  if(Object.keys(copy).sort().join(',')!=='bindingReference,policyReference,scope,sourceProjectRef,sourceTenantId'||!check(def.Reference!,copy.bindingReference,RECORD_SCHEMA)||!check(def.Reference!,copy.policyReference,RECORD_SCHEMA)||!check(def.Scope!,copy.scope,RECORD_SCHEMA)||![copy.sourceTenantId,copy.sourceProjectRef].every(x=>typeof x==='string'&&x.length>=1&&x.length<=256))refuse('denied','invalid_request');
  return freeze(copy);
}
function closedFrame(frame:FinanceBindingMutationFrame):{ frame:FinanceBindingMutationFrame; action:RecordData; hash:string } {
  const copy=JSON.parse(financeBindingCanonicalBytes(frame));if(Object.keys(copy).sort().join(',')!=='format,signedMaintainerActionCanonicalBytes'||copy.format!=='ci-finance-binding-mutation-frame-1.0.0')refuse('denied','invalid_frame');
  const action=parseClosed(copy.signedMaintainerActionCanonicalBytes);if(!check(ACTION_SCHEMA,action,ACTION_SCHEMA))refuse('denied','invalid_action');return {frame:freeze(copy),action,hash:contentHash(copy)};
}

interface FinanceSqliteDatabase {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: (string | number | bigint | null | Uint8Array)[]): Record<string, unknown> | undefined;
    all(...values: (string | number | bigint | null | Uint8Array)[]): Record<string, unknown>[];
    run(...values: (string | number | bigint | null | Uint8Array)[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
  close(): void;
}

const NATIVE_EXEC=DatabaseSync.prototype.exec;
const NATIVE_PREPARE=DatabaseSync.prototype.prepare;
function nativeTransaction(db:DatabaseSync):boolean { const descriptor=Object.getOwnPropertyDescriptor(db,'isTransaction');if(!descriptor?.get||descriptor.configurable!==false)refuse('unavailable','unsupported_custody');return descriptor.get.call(db)===true; }
function nativeExec(db:DatabaseSync,sql:string):void { NATIVE_EXEC.call(db,sql); }
function nativeRead(db:DatabaseSync,sql:string,...values:(string|number|null)[]):Record<string,unknown>|undefined { return NATIVE_PREPARE.call(db,sql).get(...values); }
type Snapshot = { epoch:number; body:RecordData };
const sourceInstances=new WeakMap<FinanceBindingCustodySource,{database:DatabaseSync; provenance:'isolated_fixture'}>();
/** Explicit isolated adapter. Reads already maintained owner records; creates no tables, issuers, keys or grants. */
export function createIsolatedFinanceSqliteCustodySource(database:FinanceSqliteDatabase):FinanceBindingCustodySource {
  if(types.isProxy(database)||!(database instanceof DatabaseSync))throw new TypeError('A native owned SQLite connection is required.');
  const probe=nativeRead(database,'SELECT 1 AS native_identity');if(probe?.native_identity!==1)throw new TypeError('Native SQLite identity unavailable.');
  const source=Object.freeze({kind:'finance_sqlite_custody_source' as const});sourceInstances.set(source,{database,provenance:'isolated_fixture'});return source;
}
function readSnapshotRows(db:DatabaseSync,bindingId:string):Snapshot {
  const state=nativeRead(db,'SELECT epoch,format FROM finance_binding_custody_state WHERE singleton=1');
  if(!state||state.format!=='ci-finance-closed-fixture-custody-1.0.0'||typeof state.epoch!=='number'||!Number.isSafeInteger(state.epoch)||state.epoch<1)refuse('unavailable','unsupported_custody');
  const pending=nativeRead(db,"SELECT operation_id FROM finance_binding_source_intents WHERE state='changing' LIMIT 1");if(pending)refuse('unavailable','source_changing');
  const row=nativeRead(db,'SELECT body FROM finance_binding_custody_snapshots WHERE binding_id=?',bindingId);if(!row||typeof row.body!=='string')refuse('unavailable','source_absent');
  return {epoch:state.epoch,body:parseClosed(row.body,2097152)};
}
function snapshot(db:DatabaseSync,bindingId:string):Snapshot {
  if(nativeTransaction(db))return readSnapshotRows(db,bindingId);
  nativeExec(db,'BEGIN');try{const value=readSnapshotRows(db,bindingId);nativeExec(db,'COMMIT');return value;}catch(error){if(nativeTransaction(db))nativeExec(db,'ROLLBACK');throw error;}
}
function now(configuration:FinanceBindingConfiguration):number { const value=configuration.clock.now().getTime();if(!Number.isFinite(value))refuse('unavailable','clock_unavailable');return value; }
function requireReference(schema:JsonSchema,value:unknown):void { if(!check(schema,value,RECORD_SCHEMA))refuse('unavailable','invalid_owned_record'); }
function verifyEnvelope(envelope:RecordData,kind:'binding'|'lineage'|'action',s:RecordData,time:number):number {
  const defs=RECORD_SCHEMA.$defs!,schema=kind==='action'?ACTION_SCHEMA:defs[kind==='binding'?'BindingEnvelope':'LineageEnvelope']!;
  if(!check(schema,envelope,kind==='action'?ACTION_SCHEMA:RECORD_SCHEMA))refuse('denied','invalid_signed_record');
  const u=envelope.unsigned,registry=s.registry;
  requireReference(defs.IssuerRegistryRecord!,registry);requireReference(defs.PrincipalSessionRecord!,s.principal);
  if(registry.state!=='active'||registry.id!==s.registryReference.id||registry.revision!==s.registryReference.revision||contentHash(registry)!==s.registryReference.contentHash)refuse('denied','registry_changed');
  const keys=registry.keys.filter((k:RecordData)=>k.id===u.issuerKeyReference.keyId&&k.revision===u.issuerKeyReference.revision);
  if(keys.length!==1)refuse('denied','issuer_not_admitted');const key=keys[0];
  const entitlementRef=kind==='action'?u.entitlementReference:u.issuerEntitlementReference;
  const ents=registry.entitlements.filter((e:RecordData)=>e.id===entitlementRef.id&&e.revision===entitlementRef.revision);
  if(ents.length!==1)refuse('denied','entitlement_not_admitted');const entitlement=ents[0];
  const issuerRef=kind==='action'?u.audience.issuerRegistryReference:u.issuerRegistryReference;
  const spki=b64(key.publicKeySpkiBase64url,44),signature=b64(envelope.signature.value,64),nativeKey=createPublicKey({key:spki,format:'der',type:'spki'});
  if(nativeKey.asymmetricKeyType!=='ed25519'||digest(spki)!==key.publicKeyContentHash||digest(spki)!==u.issuerKeyReference.publicKeyContentHash||!equal(issuerRef,s.registryReference)||!equal(u.issuerKeyReference.registryReference,s.registryReference)||key.registryId!==registry.id||key.registryRevision!==registry.revision||entitlement.registryId!==registry.id||entitlement.registryRevision!==registry.revision||key.issuerId!==entitlement.issuerId||(kind!=='action'&&u.issuerId!==key.issuerId))refuse('denied','issuer_not_admitted');
  if(!verify(null,encoder.encode(u.format+'\n'+financeBindingCanonicalBytes(u)),nativeKey,signature))refuse('denied','invalid_signature');
  const action=kind==='binding'?'bindPartition':kind==='lineage'?'registerSourceLineage':u.action;
  if(key.state!=='active'||entitlement.state!=='active'||s.principal.state!=='active'||!key.allowedRecordKinds.includes(u.format)||!key.allowedActions.includes(action)||!key.allowedScopes.some((x:unknown)=>equal(x,u.scope))||!key.entitlementReferences.some((x:unknown)=>equal(x,entitlementRef))||!entitlement.allowedRecordKinds.includes(u.format)||!entitlement.allowedActions.includes(action)||!entitlement.allowedScopes.some((x:unknown)=>equal(x,u.scope))||contentHash(entitlement)!==entitlementRef.contentHash)refuse('denied','authority_changed');
  const account=kind==='action'?u.operator.accountRef:u.maintainerAccountRef,session=kind==='action'?u.operator.sessionRef:u.maintainerSessionRef;
  if(account!==s.principal.accountRef||session!==s.principal.sessionRef||account!==entitlement.accountRef||session!==entitlement.sessionRef||!equal(s.principal.scope,u.scope)||u.sourceTenantId!==entitlement.sourceTenantId||u.sourceProjectRef!==entitlement.sourceProjectRef||!equal(u.policyReference,entitlement.policyReference))refuse('denied','principal_mismatch');
  if(kind!=='action'&&(!equal(u.issuerConfigurationReference,entitlement.issuerConfigurationReference)||!equal(u.ledgerBackendReference,entitlement.ledgerBackendReference)))refuse('denied','authority_mismatch');
  const validity=[u,key,entitlement,s.principal];if(validity.some(x=>Date.parse(x.notBefore)>=Date.parse(x.expiresAt)||(x.issuedAt!==undefined&&(Date.parse(x.issuedAt)<Date.parse(x.notBefore)||Date.parse(x.issuedAt)>time||Date.parse(x.issuedAt)>=Date.parse(x.expiresAt)))))refuse('denied','invalid_validity');if(validity.some(x=>time<Date.parse(x.notBefore)||time>=Date.parse(x.expiresAt)))refuse('denied','expired');return Math.min(...validity.map(x=>Date.parse(x.expiresAt)));
}
function admitted(request:FinanceBindingRequest,snapshotValue:Snapshot,configuration:FinanceBindingConfiguration,time:number,action?:RecordData):{s:RecordData;lineages:RecordData[];expires:number;commitment:string} {
  const s=snapshotValue.body,defs=RECORD_SCHEMA.$defs!;
  for(const key of ['registryReference','policyReference','backendReference','configurationReference'])requireReference(defs.Reference!,s[key]);
  if(!Array.isArray(s.lineages)||s.lineages.length<1||s.lineages.length>16||!Array.isArray(s.artifacts)||s.artifacts.length>32)refuse('unavailable','source_absent');
  if(s.lineages.some((e:unknown)=>!check(defs.LineageEnvelope!,e,RECORD_SCHEMA)))refuse('denied','invalid_signed_record');
  if(!equal(s.backendReference,configuration.selectedBackend.reference))refuse('unavailable','backend_mismatch');
  let expires=verifyEnvelope(s.binding,'binding',s,time);const u=s.binding.unsigned;
  const bindingRef={id:u.id,revision:u.revision,contentHash:contentHash(u)};
  if(!equal(bindingRef,request.bindingReference)||!equal(u.policyReference,request.policyReference)||!equal(u.policyReference,s.policyReference)||!equal(u.issuerConfigurationReference,s.configurationReference)||!equal(u.ledgerBackendReference,s.backendReference)||!equal(u.scope,request.scope)||u.sourceTenantId!==request.sourceTenantId||u.sourceProjectRef!==request.sourceProjectRef||u.state!=='active')refuse('denied','binding_mismatch');
  const {actorId:_actor,...partition}=request.scope;if(!equal(u.partition,partition))refuse('denied','scope_mismatch');
  function head(kind:string,envelope:RecordData):void {const h=s.heads?.[kind+':'+envelope.unsigned.id];requireReference(defs.MaintainedSignedRecordHead!,h);if(h.state!=='active'||!equal(h.recordReference,{id:envelope.unsigned.id,revision:envelope.unsigned.revision,contentHash:contentHash(envelope.unsigned)})||h.signedRecordContentHash!==contentHash(envelope))refuse('denied','current_source_changed');}
  head('binding',s.binding);
  function artifact(reference:FinanceBindingReference):void {const matches=s.artifacts.filter((x:RecordData)=>equal(x.reference,reference));if(matches.length!==1)refuse('unavailable','custody_absent');const a=matches[0];const actual=a.encoding==='utf8'&&typeof a.body==='string'?digest(a.body):a.encoding==='canonical_json'?contentHash(a.body):'';if(actual!==reference.contentHash)refuse('denied','custody_changed');}
  for(const ref of [s.policyReference,s.backendReference,s.configurationReference,...Object.values(u.sourceCustodyReferences)])artifact(ref as FinanceBindingReference);
  const lineages:RecordData[]=[];
  for(const reference of u.sourceLineageReferences){const matches=s.lineages.filter((e:RecordData)=>equal(reference,{id:e.unsigned.id,revision:e.unsigned.revision,contentHash:contentHash(e.unsigned)}));if(matches.length!==1)refuse('unavailable','ambiguous_lineage');const e=matches[0];expires=Math.min(expires,verifyEnvelope(e,'lineage',s,time));head('lineage',e);for(const key of ['scope','partition','sourceTenantId','sourceProjectRef','ledgerBackendReference','policyReference','issuerConfigurationReference','sourceCustodyReferences','maintainerAccountRef','maintainerSessionRef'])if(!equal(e.unsigned[key],u[key]))refuse('denied','lineage_mismatch');if(e.unsigned.state!=='active')refuse('denied','revoked');lineages.push(e);}
  if(new Set(lineages.map(e=>financeBindingCanonicalBytes(e.unsigned.sourceIdentity))).size!==lineages.length)refuse('unavailable','ambiguous_lineage');
  if(action){if(!s.action||!check(ACTION_SCHEMA,s.action,ACTION_SCHEMA)||!equal(s.action,action))refuse('denied','current_action_changed');head('action',action);expires=Math.min(expires,verifyEnvelope(action,'action',s,time));const a=action.unsigned,m=a.change.mapping;
    if(a.target.mappingId!==m.id||a.changeContentHash!==contentHash(a.change)||!equal(a.expectedPrior,s.prior)||!equal(a.audience.issuerRegistryReference,s.registryReference)||a.audience.verifierId!==s.registry.verifierId||!equal(a.audience.financeBackendReference,s.backendReference)||!equal(a.target.hostConfigurationReference,s.configurationReference)||!equal(a.policyReference,u.policyReference)||!equal(a.financeBindingReference,bindingRef)||!equal(m.financeBindingReference,bindingRef)||!equal(m.policyReference,u.policyReference)||!equal(m.issuerConfigurationReference,s.configurationReference)||!equal(m.sourceCustodyReferences,u.sourceCustodyReferences)||m.governanceAction.id!==a.id||m.governanceAction.revision!==a.revision||!equal(m.ledgerPartition,u.partition)||!equal(m.scope,u.scope)||!equal(a.scope,u.scope)||a.sourceTenantId!==u.sourceTenantId||a.sourceProjectRef!==u.sourceProjectRef||m.sourceTenantId!==u.sourceTenantId||m.sourceProjectRef!==u.sourceProjectRef||m.sourceAudience!==s.sourceAudience||!equal(m.operationRecords,s.operationRecords))refuse('denied','action_mismatch');
    const prior=s.prior;if(a.action==='provisionMapping'&&(prior.state!=='absent'||prior.revision!==null||prior.contentHash!==null||m.revision!==1||m.state!=='active'))refuse('denied','prior_mismatch');if(a.action!=='provisionMapping'&&(prior.state==='absent'||!Number.isSafeInteger(prior.revision)||m.revision!==prior.revision+1||(a.action==='revokeMapping'?m.state!=='revoked':m.state!=='active')))refuse('denied','prior_mismatch');
    if(time<Date.parse(m.verifiedAt)||time>=Date.parse(m.expiresAt))refuse('denied','expired');expires=Math.min(expires,Date.parse(m.expiresAt));
  }
  return {s,lineages,expires,commitment:contentHash({epoch:snapshotValue.epoch,body:s})};
}
async function proveAnchors(configuration:FinanceBindingConfiguration,request:FinanceBindingRequest,lineages:RecordData[]):Promise<void> {
  let client:ReportingTransactionPort|undefined,transaction=false;
  try {client=await configuration.selectedBackend.database.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;await client.query("SET LOCAL statement_timeout='5000ms'");await client.query("SET LOCAL lock_timeout='2000ms'");await bindFinancialDatabaseScope(client,request.scope);
    const meta=await client.query('SELECT current_database() AS database_name,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user');if(meta.rows.length!==1||meta.rows[0]!.database_name!==configuration.selectedBackend.databaseName||meta.rows[0]!.rolsuper!==false||meta.rows[0]!.rolbypassrls!==false)refuse('unavailable','backend_mismatch');
    const health=await client.query('SELECT migrations_ready,required_migrations_present FROM cost_intelligence.foundation_health');if(health.rows.length!==1||health.rows[0]!.migrations_ready!==true||health.rows[0]!.required_migrations_present!==11)refuse('unavailable','unsupported_schema');
    const rls=await client.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cost_intelligence' AND c.relname IN ('financial_source_revision_heads','financial_ledger_events') ORDER BY c.relname");if(rls.rows.length!==2||rls.rows.some(r=>r.relrowsecurity!==true||r.relforcerowsecurity!==true))refuse('unavailable','unsupported_schema');
    for(const e of lineages){const u=e.unsigned,id=u.sourceIdentity;const rows=await client.query(`SELECT h.current_revision_sequence,h.current_event_id,e.event_hash,e.economic_root_event_id,origin.event_hash AS origin_event_hash FROM cost_intelligence.financial_source_revision_heads h JOIN cost_intelligence.financial_ledger_events e ON e.event_id=h.current_event_id JOIN cost_intelligence.financial_ledger_events origin ON origin.event_id=e.economic_root_event_id WHERE h.tenant_id=$1 AND h.project_id=$2 AND h.environment=$3 AND h.billing_mode=$4 AND h.source_name=$5 AND h.source_object_id=$6 AND h.source_revision_subject_id=$7 AND e.tenant_id=h.tenant_id AND e.project_id=h.project_id AND e.environment=h.environment AND e.billing_mode=h.billing_mode AND e.source_name=h.source_name AND e.source_object_id=h.source_object_id AND e.source_revision_subject_id=h.source_revision_subject_id AND origin.tenant_id=h.tenant_id AND origin.project_id=h.project_id AND origin.environment=h.environment AND origin.billing_mode=h.billing_mode AND origin.source_name=h.source_name AND origin.source_object_id=h.source_object_id AND origin.source_revision_subject_id=h.source_revision_subject_id LIMIT 2`,[request.scope.tenantId,request.scope.projectId,request.scope.environment,request.scope.billingMode,id.sourceName,id.sourceObjectId,id.revisionSubjectId]);if(rows.rows.length!==1)refuse('unavailable','partition_source_absent');const row=rows.rows[0]!;if(String(row.current_revision_sequence)!==String(u.currentHead.revisionSequence)||row.current_event_id!==u.currentHead.eventId||row.event_hash!==u.currentHead.eventHash||row.economic_root_event_id!==u.rootEvent.eventId||row.origin_event_hash!==u.rootEvent.eventHash)refuse('denied','lineage_mismatch');}
    await client.query('COMMIT');transaction=false;
  } finally {if(client){if(transaction)await client.query('ROLLBACK').catch(()=>{});client.release();}}
}

type GuardState = { token:FinancePrivateTransactionGuard; frame:{frame:FinanceBindingMutationFrame;action:RecordData;hash:string}; phase:'held'|'preparing'|'prepared'|'validated'|'ended'; handle?:FinancePrivateBindingHandle; request?:FinanceBindingRequest; commitment?:string; expires?:number; verifiedAt?:number };
/** No live source is installed by default. This factory does not mount a query/export grant. */
export function createFinanceLedgerPartitionBindingVerifier(input?:FinanceBindingConfiguration):{bindingVerifier:FinanceLedgerPartitionBindingPort;bindingCurrentness:FinanceOwnedBindingCurrentnessPort;guardLifecycle:FinanceBindingGuardLifecyclePort} {
  let configuration:FinanceBindingConfiguration|undefined,source:ReturnType<typeof sourceInstances.get>;
  try {if(input){source=sourceInstances.get(input.custodySource);if(source){const reference=JSON.parse(financeBindingCanonicalBytes(input.selectedBackend.reference));requireReference(RECORD_SCHEMA.$defs!.Reference!,reference);if(typeof input.selectedBackend.databaseName!=='string'||input.selectedBackend.databaseName.length<1||input.selectedBackend.databaseName.length>128)refuse('unavailable','backend_unavailable');const connect=input.selectedBackend.database.connect.bind(input.selectedBackend.database),clock=input.clock.now.bind(input.clock);configuration={custodySource:input.custodySource,selectedBackend:{reference:freeze(reference),databaseName:input.selectedBackend.databaseName,database:{connect}},clock:{now:clock}};}}}catch{configuration=undefined;source=undefined;}
  const guards=new WeakMap<FinancePrivateTransactionGuard,GuardState>(),handles=new WeakMap<FinancePrivateBindingHandle,GuardState>(),active=new Set<GuardState>();let destroyed=false,busy=false;
  const available=()=>{if(destroyed||!configuration||!source)refuse('unavailable','unconfigured');return {configuration:configuration!,source:source!};};
  const enter=()=>{if(busy)refuse('denied','reentrant_operation');busy=true;};
  function end(g:GuardState):void{g.phase='ended';active.delete(g);if(g.handle)handles.delete(g.handle);guards.delete(g.token);}
  function rollback(g:GuardState):void {const {source}=available();try{if(nativeTransaction(source.database))nativeExec(source.database,'ROLLBACK');}finally{end(g);}}
  function held(g:GuardState):void {const {source}=available();if(g.phase==='ended'||!active.has(g)||guards.get(g.token)!==g||!nativeTransaction(source.database))refuse('denied','foreign_or_ended_guard');}
  function current(g:GuardState,frame:FinanceBindingMutationFrame):void {const {configuration,source}=available();held(g);if(!g.handle||!g.request||!g.commitment||g.expires===undefined||!['prepared','validated'].includes(g.phase))refuse('denied','handle_not_ready');const f=closedFrame(frame);if(f.hash!==g.frame.hash)refuse('denied','frame_mismatch');const time=now(configuration);if(g.verifiedAt===undefined||time<g.verifiedAt)refuse('denied','clock_changed');if(time>=g.expires!)refuse('denied','expired');const proof=admitted(g.request!,snapshot(source.database,g.request!.bindingReference.id),configuration,time,g.frame.action);if(proof.commitment!==g.commitment)refuse('denied','current_source_changed');held(g);}
  async function observe(request:FinanceBindingRequest,guard?:GuardState):Promise<FinanceBindingObservation> {const {configuration,source}=available();const copied=closedRequest(request);if(nativeTransaction(source.database)&&!guard)refuse('unavailable','custody_busy');const time=now(configuration),before=snapshot(source.database,copied.bindingReference.id),proof=admitted(copied,before,configuration,time,guard?.frame.action);if(guard)held(guard);await proveAnchors(configuration,copied,proof.lineages);available();if(guard)held(guard);const finalTime=now(configuration),after=snapshot(source.database,copied.bindingReference.id),refreshed=admitted(copied,after,configuration,finalTime,guard?.frame.action);if(refreshed.commitment!==proof.commitment)refuse('denied','current_source_changed');if(finalTime<time)refuse('unavailable','clock_unavailable');const expires=Math.min(time+60000,proof.expires,refreshed.expires);if(finalTime>=expires)refuse('denied','expired');return freeze({status:'verified',bindingReference:JSON.parse(financeBindingCanonicalBytes(copied.bindingReference)),policyReference:JSON.parse(financeBindingCanonicalBytes(copied.policyReference)),scope:JSON.parse(financeBindingCanonicalBytes(copied.scope)),sourceTenantId:copied.sourceTenantId,sourceProjectRef:copied.sourceProjectRef,ledgerBackendReference:JSON.parse(financeBindingCanonicalBytes(configuration.selectedBackend.reference)),sourceLineageReferences:JSON.parse(financeBindingCanonicalBytes(proof.s.binding.unsigned.sourceLineageReferences)),currentEpochCommitment:proof.commitment,verifiedAt:new Date(finalTime).toISOString(),expiresAt:new Date(expires).toISOString(),provenance:'isolated_fixture'});
  }
  const bindingVerifier:FinanceLedgerPartitionBindingPort=Object.freeze({async verifyCurrentBinding(request:FinanceBindingRequest){let entered=false;try{enter();entered=true;return await observe(request);}catch(error){return resultOf(error);}finally{if(entered)busy=false;}}});
  const bindingCurrentness:FinanceOwnedBindingCurrentnessPort=Object.freeze({
    async prepareCurrentness(token:FinancePrivateTransactionGuard,request:FinanceBindingRequest,frame:FinanceBindingMutationFrame){let g:GuardState|undefined,entered=false;try{enter();entered=true;available();g=guards.get(token);if(!g||g.phase!=='held')refuse('denied','foreign_or_ended_guard');held(g!);if(closedFrame(frame).hash!==g!.frame.hash)refuse('denied','frame_mismatch');const copied=closedRequest(request);g!.phase='preparing';const observation=await observe(copied,g);held(g!);g!.request=copied;g!.commitment=observation.currentEpochCommitment;g!.expires=Date.parse(observation.expiresAt);g!.verifiedAt=Date.parse(observation.verifiedAt);const handle=Object.freeze({kind:'finance_private_binding_handle' as const});g!.handle=handle;handles.set(handle,g!);g!.phase='prepared';return {status:'ready' as const,privateBindingHandle:handle};}catch(error){if(g&&g.phase!=='ended'){try{rollback(g);}catch{end(g);}}return resultOf(error);}finally{if(entered)busy=false;}},
    validateCurrent(handle:FinancePrivateBindingHandle,frame:FinanceBindingMutationFrame){let entered=false;try{enter();entered=true;available();const g=handles.get(handle);if(!g||g.phase!=='prepared')refuse('denied','foreign_or_ended_handle');current(g!,frame);g!.phase='validated';queueMicrotask(()=>{if(g!.phase==='validated'){try{rollback(g!);}catch{end(g!);}}});return {status:'current' as const};}catch(error){return resultOf(error);}finally{if(entered)busy=false;}},
  });
  const guardLifecycle:FinanceBindingGuardLifecyclePort=Object.freeze({
    acquireGuard(frame:FinanceBindingMutationFrame){let entered=false;try{enter();entered=true;const {source}=available();const f=closedFrame(frame);if(active.size||nativeTransaction(source.database))refuse('denied','custody_busy');nativeExec(source.database,'PRAGMA busy_timeout=0');nativeExec(source.database,'BEGIN IMMEDIATE');const token=Object.freeze({kind:'finance_private_transaction_guard' as const}),g:GuardState={token,frame:f,phase:'held'};guards.set(token,g);active.add(g);return {status:'held' as const,guard:token};}catch(error){return resultOf(error);}finally{if(entered)busy=false;}},
    commitGuard(token:FinancePrivateTransactionGuard){let g:GuardState|undefined,entered=false;try{enter();entered=true;available();g=guards.get(token);if(!g||g.phase!=='validated')refuse('denied','foreign_or_ended_guard');current(g!,g!.frame.frame);nativeExec(source!.database,'COMMIT');end(g!);return {status:'committed' as const};}catch(error){if(g&&g.phase!=='ended'){let transaction=false;try{transaction=nativeTransaction(source!.database);}catch{}if(transaction){try{nativeExec(source!.database,'ROLLBACK');end(g);return resultOf(error);}catch{end(g);return {status:'indeterminate' as const};}}end(g);return {status:'indeterminate' as const};}return resultOf(error);}finally{if(entered)busy=false;}},
    rollbackGuard(token:FinancePrivateTransactionGuard){let entered=false;try{enter();entered=true;available();const g=guards.get(token);if(!g)refuse('denied','foreign_or_ended_guard');held(g!);rollback(g!);return {status:'rolled_back' as const};}catch(error){return resultOf(error);}finally{if(entered)busy=false;}},
    destroy(){for(const g of active){try{rollback(g);}catch{end(g);}}destroyed=true;},
  });
  return Object.freeze({bindingVerifier,bindingCurrentness,guardLifecycle});
}
