/** Identifies the file as one of ours, distinct from someone uploading an unrelated JSON file. */
export const EXPORT_FORMAT = 'kitchen.household-export';

/** Bumped on any breaking change to the export shape; import rejects anything else. */
export const SCHEMA_VERSION = 1;
