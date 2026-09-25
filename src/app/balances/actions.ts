"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  createBalanceObservationService,
  isBalanceObservationError,
  utcTimestampSchema,
  type BalanceObservationService,
} from "@/core/ledger";
import { createDatabase } from "@/infrastructure/database/client";
import { createPostgresBalanceObservationStore } from "@/infrastructure/database/postgres-balance-observations";

export interface BalanceActionState {
  status: "idle" | "success" | "error";
  message: string;
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function actionError(error: unknown): BalanceActionState {
  if (error instanceof z.ZodError) {
    return {
      status: "error",
      message: error.issues[0]?.message ?? "Check the submitted values.",
    };
  }
  if (isBalanceObservationError(error)) {
    return { status: "error", message: error.reason };
  }
  return {
    status: "error",
    message: "The ledger could not save this balance. Try again.",
  };
}

async function withService(
  operation: (service: BalanceObservationService) => Promise<unknown>,
  successMessage: string,
): Promise<BalanceActionState> {
  const connection = createDatabase();
  try {
    const service = createBalanceObservationService(
      createPostgresBalanceObservationStore(connection.database),
      () => utcTimestampSchema.parse(new Date().toISOString()),
    );
    await operation(service);
    revalidatePath("/");
    return { status: "success", message: successMessage };
  } catch (error) {
    return actionError(error);
  } finally {
    await connection.close();
  }
}

export async function recordBalanceAction(
  _previousState: BalanceActionState,
  formData: FormData,
): Promise<BalanceActionState> {
  return withService(
    (service) =>
      service.recordManualBalance({
        observationId: randomUUID(),
        accountId: field(formData, "accountId"),
        observedOn: field(formData, "observedOn"),
        enteredAmount: field(formData, "enteredAmount"),
      }),
    "Balance recorded.",
  );
}

export async function correctBalanceAction(
  _previousState: BalanceActionState,
  formData: FormData,
): Promise<BalanceActionState> {
  return withService(
    (service) =>
      service.correctBalance({
        observationId: randomUUID(),
        supersedesObservationId: field(formData, "supersedesObservationId"),
        accountId: field(formData, "accountId"),
        observedOn: field(formData, "observedOn"),
        enteredAmount: field(formData, "enteredAmount"),
      }),
    "Balance corrected.",
  );
}

export async function retractBalanceAction(
  _previousState: BalanceActionState,
  formData: FormData,
): Promise<BalanceActionState> {
  return withService(
    (service) =>
      service.retractBalance({
        retractionId: randomUUID(),
        observationId: field(formData, "observationId"),
      }),
    "Balance retracted.",
  );
}
