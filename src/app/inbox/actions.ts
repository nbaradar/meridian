"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { isInboxError, type InboxService } from "@/core/inbox";

import { withInboxService } from "./inbox-service";

export interface InboxActionState {
  status: "idle" | "success" | "error";
  message: string;
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function actionError(error: unknown): InboxActionState {
  if (error instanceof z.ZodError) {
    return {
      status: "error",
      message: error.issues[0]?.message ?? "Check the submitted values.",
    };
  }
  if (isInboxError(error)) {
    return { status: "error", message: error.reason };
  }
  return {
    status: "error",
    message: "The Inbox could not save this change. Try again.",
  };
}

async function run(
  operation: (service: InboxService) => Promise<unknown>,
  successMessage: string,
): Promise<InboxActionState> {
  try {
    await withInboxService(operation);
  } catch (error) {
    return actionError(error);
  }
  // Every page shows the Inbox count.
  revalidatePath("/", "layout");
  return { status: "success", message: successMessage };
}

function taskFields(formData: FormData) {
  return {
    title: field(formData, "title"),
    note: field(formData, "note"),
    accountId: field(formData, "accountId"),
    link: field(formData, "link"),
    dueOn: field(formData, "dueOn"),
  };
}

export async function addTaskAction(
  _previousState: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  return run(
    (service) =>
      service.addTask({ taskId: randomUUID(), ...taskFields(formData) }),
    "Task added.",
  );
}

export async function editTaskAction(
  _previousState: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  return run(
    (service) =>
      service.editTask({
        taskId: field(formData, "taskId"),
        ...taskFields(formData),
      }),
    "Task saved.",
  );
}

export async function completeTaskAction(
  _previousState: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  return run(
    (service) => service.completeTask({ taskId: field(formData, "taskId") }),
    "Task done.",
  );
}

export async function reopenTaskAction(
  _previousState: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  return run(
    (service) => service.reopenTask({ taskId: field(formData, "taskId") }),
    "Task reopened.",
  );
}

export async function deleteTaskAction(
  _previousState: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  return run(
    (service) => service.deleteTask({ taskId: field(formData, "taskId") }),
    "Task deleted.",
  );
}

export async function snoozeItemAction(
  _previousState: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  return run(
    (service) =>
      service.snooze({
        itemKey: field(formData, "itemKey"),
        itemVersion: field(formData, "itemVersion"),
        choice: field(formData, "choice"),
        until: field(formData, "until"),
      }),
    "Item snoozed.",
  );
}

export async function dismissItemAction(
  _previousState: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  return run(
    (service) =>
      service.dismiss({
        itemKey: field(formData, "itemKey"),
        itemVersion: field(formData, "itemVersion"),
      }),
    "Item dismissed.",
  );
}

export async function restoreItemAction(
  _previousState: InboxActionState,
  formData: FormData,
): Promise<InboxActionState> {
  return run(
    (service) => service.restore({ itemKey: field(formData, "itemKey") }),
    "Item restored.",
  );
}
