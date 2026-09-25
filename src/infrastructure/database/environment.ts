import { z } from "zod";

const databaseUrlSchema = z.url().superRefine((value, context) => {
  const protocol = new URL(value).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    context.addIssue({
      code: "custom",
      message: "DATABASE_URL must use the postgres or postgresql protocol",
    });
  }
});

export const databaseEnvironmentSchema = z.object({
  DATABASE_URL: databaseUrlSchema,
});

export const migrationEnvironmentSchema = z.object({
  DATABASE_OWNER_URL: databaseUrlSchema,
});

export const operationalDatabaseEnvironmentSchema = z.object({
  OPS_CONTROL_DATABASE_URL: databaseUrlSchema,
  READ_WORKER_DATABASE_URL: databaseUrlSchema,
});

const base64KeySchema = z.string().superRefine((value, context) => {
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length !== 32 ||
    decoded.toString("base64").replaceAll("=", "") !== value.replaceAll("=", "")
  ) {
    context.addIssue({
      code: "custom",
      message: "RAW_PAYLOAD_ENCRYPTION_KEY must encode exactly 32 bytes",
    });
  }
});

const protectedKeyIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const keyringJsonSchema = z.string().transform((value, context) => {
  try {
    const parsed = z
      .record(protectedKeyIdSchema, base64KeySchema)
      .parse(JSON.parse(value));
    if (Object.keys(parsed).length === 0) throw new Error("empty keyring");
    return parsed;
  } catch {
    context.addIssue({
      code: "custom",
      message: "Operational keyring must be a non-empty JSON key map",
    });
    return z.NEVER;
  }
});

export const rawPayloadEncryptionEnvironmentSchema = z.object({
  RAW_PAYLOAD_KEY_ID: z.string().trim().min(1),
  RAW_PAYLOAD_ENCRYPTION_KEY: base64KeySchema,
});

export const credentialProtectionEnvironmentSchema = z
  .object({
    OPS_CREDENTIAL_CURRENT_KEY_ID: protectedKeyIdSchema,
    OPS_CREDENTIAL_KEYRING: keyringJsonSchema,
  })
  .superRefine((value, context) => {
    if (
      !(value.OPS_CREDENTIAL_CURRENT_KEY_ID in value.OPS_CREDENTIAL_KEYRING)
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPS_CREDENTIAL_CURRENT_KEY_ID"],
        message: "Current credential key ID must exist in its keyring",
      });
    }
  });

export const identityProtectionEnvironmentSchema = z
  .object({
    OPS_IDENTITY_CURRENT_KEY_ID: protectedKeyIdSchema,
    OPS_IDENTITY_KEYRING: keyringJsonSchema,
    OPS_IDENTITY_DIGEST_CURRENT_KEY_ID: protectedKeyIdSchema,
    OPS_IDENTITY_DIGEST_KEYRING: keyringJsonSchema,
  })
  .superRefine((value, context) => {
    if (!(value.OPS_IDENTITY_CURRENT_KEY_ID in value.OPS_IDENTITY_KEYRING)) {
      context.addIssue({
        code: "custom",
        path: ["OPS_IDENTITY_CURRENT_KEY_ID"],
        message: "Current identity key ID must exist in its keyring",
      });
    }
    if (
      !(
        value.OPS_IDENTITY_DIGEST_CURRENT_KEY_ID in
        value.OPS_IDENTITY_DIGEST_KEYRING
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPS_IDENTITY_DIGEST_CURRENT_KEY_ID"],
        message: "Current identity digest key ID must exist in its keyring",
      });
    }
  });

export const ynabLabelDigestEnvironmentSchema = z
  .object({
    YNAB_LABEL_DIGEST_CURRENT_KEY_ID: protectedKeyIdSchema,
    YNAB_LABEL_DIGEST_KEYRING: keyringJsonSchema,
  })
  .superRefine((value, context) => {
    if (
      !(
        value.YNAB_LABEL_DIGEST_CURRENT_KEY_ID in
        value.YNAB_LABEL_DIGEST_KEYRING
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["YNAB_LABEL_DIGEST_CURRENT_KEY_ID"],
        message: "Current YNAB label digest key ID must exist in its keyring",
      });
    }
  });

export type DatabaseEnvironment = z.infer<typeof databaseEnvironmentSchema>;
export type YnabLabelDigestEnvironment = z.infer<
  typeof ynabLabelDigestEnvironmentSchema
>;
export type MigrationEnvironment = z.infer<typeof migrationEnvironmentSchema>;
export type OperationalDatabaseEnvironment = z.infer<
  typeof operationalDatabaseEnvironmentSchema
>;
export type CredentialProtectionEnvironment = z.infer<
  typeof credentialProtectionEnvironmentSchema
>;
export type IdentityProtectionEnvironment = z.infer<
  typeof identityProtectionEnvironmentSchema
>;
export type RawPayloadEncryptionEnvironment = z.infer<
  typeof rawPayloadEncryptionEnvironmentSchema
>;

export function databaseEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseEnvironment {
  return databaseEnvironmentSchema.parse(environment);
}

export function migrationEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MigrationEnvironment {
  return migrationEnvironmentSchema.parse(environment);
}

export function operationalDatabaseEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OperationalDatabaseEnvironment {
  return operationalDatabaseEnvironmentSchema.parse(environment);
}

export function credentialProtectionEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CredentialProtectionEnvironment {
  return credentialProtectionEnvironmentSchema.parse(environment);
}

export function identityProtectionEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): IdentityProtectionEnvironment {
  return identityProtectionEnvironmentSchema.parse(environment);
}

export function rawPayloadEncryptionEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RawPayloadEncryptionEnvironment {
  return rawPayloadEncryptionEnvironmentSchema.parse(environment);
}

export function ynabLabelDigestEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): YnabLabelDigestEnvironment {
  return ynabLabelDigestEnvironmentSchema.parse(environment);
}
