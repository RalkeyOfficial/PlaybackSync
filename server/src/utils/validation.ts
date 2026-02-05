/**
 * JSON Schema validation utility for WebSocket messages
 * Uses ajv for fast, efficient message validation
 */

import Ajv, { type ValidateFunction, type ErrorObject } from 'ajv';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Message type names that correspond to schema files
 */
export type MessageSchemaType =
  | 'JOIN'
  | 'EVENT'
  | 'EPISODE_CHANGE_REQUEST'
  | 'TIME_REPORT'
  | 'HEARTBEAT'
  | 'SYNC_ADJUST'
  | 'STATE'
  | 'COMMAND'
  | 'ERROR';

/**
 * Validation result
 */
export interface ValidationResult {
  /** Whether the message is valid */
  valid: boolean;
  /** Validation errors (null if valid) */
  errors: ErrorObject[] | null;
}

/**
 * Schema map type
 */
type SchemaMap = Record<MessageSchemaType, object>;

/**
 * Validator map type
 */
type ValidatorMap = Record<MessageSchemaType, ValidateFunction>;

/**
 * Load all JSON schemas from the schemas directory
 */
function loadSchemasInternal(): SchemaMap {
  const schemasDir = join(__dirname, '../../schemas');
  const schemaFiles: Record<MessageSchemaType, string> = {
    JOIN: 'join.json',
    EVENT: 'event.json',
    EPISODE_CHANGE_REQUEST: 'episode-change-request.json',
    TIME_REPORT: 'time-report.json',
    HEARTBEAT: 'heartbeat.json',
    SYNC_ADJUST: 'sync-adjust.json',
    STATE: 'state.json',
    COMMAND: 'command.json',
    ERROR: 'error.json',
  };

  const loadedSchemas: Partial<SchemaMap> = {};

  for (const [type, filename] of Object.entries(schemaFiles) as Array<
    [MessageSchemaType, string]
  >) {
    const filePath = join(schemasDir, filename);
    const schemaContent = readFileSync(filePath, 'utf-8');
    loadedSchemas[type] = JSON.parse(schemaContent);
  }

  return loadedSchemas as SchemaMap;
}

/**
 * Create and configure ajv validator instance
 */
function createValidator(): Ajv {
  const ajv = new Ajv({
    allErrors: true,
    strict: false, // Disable strict mode to allow conditional required properties
    validateSchema: true,
    removeAdditional: false,
    useDefaults: false,
    coerceTypes: false,
  });

  // Add custom format validators
  ajv.addFormat('uri', {
    type: 'string',
    validate: (data: string) => {
      try {
        new URL(data);
        return true;
      } catch {
        return false;
      }
    },
  });

  return ajv;
}

/**
 * Initialize validators for all message types
 */
let validators: ValidatorMap | null = null;
let schemas: SchemaMap | null = null;

/**
 * Initialize the validation system
 * Loads schemas and compiles validators
 */
function initializeValidators(): void {
  if (validators && schemas) {
    return; // Already initialized
  }

  schemas = loadSchemasInternal();
  const ajv = createValidator();

  validators = {} as ValidatorMap;

  for (const [type, schema] of Object.entries(schemas) as Array<[MessageSchemaType, object]>) {
    validators[type] = ajv.compile(schema);
  }
}

/**
 * Get a schema by type
 * @param type - Message schema type
 * @returns Schema object
 */
export function getSchema(type: MessageSchemaType): object {
  if (!schemas) {
    initializeValidators();
  }
  return schemas![type];
}

/**
 * Validate a message against its schema
 * @param message - Message object to validate
 * @param type - Message schema type
 * @returns Validation result
 */
export function validateMessage(message: unknown, type: MessageSchemaType): ValidationResult {
  // Initialize validators if not already done
  if (!validators) {
    initializeValidators();
  }

  const validator = validators![type];

  if (!validator) {
    return {
      valid: false,
      errors: [
        {
          keyword: 'unknown',
          instancePath: '',
          schemaPath: '',
          params: {},
          message: `Unknown message type: ${type}`,
        },
      ],
    };
  }

  const valid = validator(message);

  return {
    valid,
    errors: valid ? null : validator.errors || [],
  };
}

/**
 * Format validation errors into a human-readable string
 * @param errors - Array of validation errors
 * @returns Formatted error message
 */
export function formatValidationError(errors: ErrorObject[]): string {
  if (errors.length === 0) {
    return 'Validation failed';
  }

  const errorMessages = errors.map(error => {
    const path = error.instancePath || error.schemaPath || 'root';
    const message = error.message || 'Invalid value';
    return `${path}: ${message}`;
  });

  return errorMessages.join('; ');
}

/**
 * Get all loaded schemas
 * @returns Map of schema types to schema objects
 */
export function loadSchemas(): SchemaMap {
  if (!schemas) {
    initializeValidators();
  }
  return schemas!;
}
