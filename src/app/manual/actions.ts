"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  createLedgerDestinationService,
  LedgerDestinationConflictError,
  LedgerDestinationReferenceError,
  utcTimestampSchema,
} from "@/core/ledger";
import { createDatabase } from "@/infrastructure/database/client";
import { createPostgresLedgerDestinationStore } from "@/infrastructure/database/postgres-ledger-destinations";

export interface ManualEntryActionState {
  status: "idle" | "success" | "error";
  message: string;
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function actionError(error: unknown): ManualEntryActionState {
  if (error instanceof z.ZodError) {
    return {
      status: "error",
      message: error.issues[0]?.message ?? "Check the submitted values.",
    };
  }
  if (
    error instanceof LedgerDestinationConflictError ||
    error instanceof LedgerDestinationReferenceError
  ) {
    return { status: "error", message: error.message };
  }
  return {
    status: "error",
    message: "The ledger could not save this entry. Try again.",
  };
}

async function withService<T>(
  operation: (
    service: ReturnType<typeof createLedgerDestinationService>,
  ) => Promise<T>,
): Promise<T> {
  const connection = createDatabase();
  try {
    const store = createPostgresLedgerDestinationStore(connection.database);
    const service = createLedgerDestinationService(store, () =>
      utcTimestampSchema.parse(new Date().toISOString()),
    );
    return await operation(service);
  } finally {
    await connection.close();
  }
}

export async function createAccountAction(
  _previousState: ManualEntryActionState,
  formData: FormData,
): Promise<ManualEntryActionState> {
  try {
    const openedOn = field(formData, "openedOn");
    await withService((service) =>
      service.createAccount({
        accountId: randomUUID(),
        revisionId: randomUUID(),
        name: field(formData, "name"),
        accountType: field(formData, "accountType"),
        accountClass:
          field(formData, "accountType") === "other"
            ? field(formData, "accountClass")
            : null,
        openedOn: openedOn === "" ? null : openedOn,
      }),
    );
    revalidatePath("/");
    return { status: "success", message: "Account created." };
  } catch (error) {
    return actionError(error);
  }
}

export async function createCategoryAction(
  _previousState: ManualEntryActionState,
  formData: FormData,
): Promise<ManualEntryActionState> {
  try {
    const parentCategoryId = field(formData, "parentCategoryId");
    await withService((service) =>
      service.createCategory({
        categoryId: randomUUID(),
        revisionId: randomUUID(),
        name: field(formData, "name"),
        kind: field(formData, "kind"),
        parentCategoryId: parentCategoryId === "" ? null : parentCategoryId,
      }),
    );
    revalidatePath("/");
    return { status: "success", message: "Category created." };
  } catch (error) {
    return actionError(error);
  }
}
