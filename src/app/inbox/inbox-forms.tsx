"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  addTaskAction,
  completeTaskAction,
  deleteTaskAction,
  dismissItemAction,
  editTaskAction,
  reopenTaskAction,
  restoreItemAction,
  snoozeItemAction,
  type InboxActionState,
} from "./actions";

const initialState: InboxActionState = { status: "idle", message: "" };

export interface TaskAccountOption {
  id: string;
  name: string;
}

/** The editable fields of a task, as strings for form defaults. */
export interface TaskFormValues {
  title: string;
  note: string;
  accountId: string;
  link: string;
  dueOn: string;
}

function SubmitButton({
  children,
  className,
}: Readonly<{ children: React.ReactNode; className?: string }>) {
  const { pending } = useFormStatus();
  return (
    <button className={className} type="submit" disabled={pending}>
      {pending ? "Saving..." : children}
    </button>
  );
}

function FormMessage({ state }: Readonly<{ state: InboxActionState }>) {
  if (state.status === "idle") return null;
  return (
    <p className={`form-message ${state.status}`} aria-live="polite">
      {state.message}
    </p>
  );
}

function TaskFields({
  accounts,
  values,
}: Readonly<{
  accounts: readonly TaskAccountOption[];
  values: TaskFormValues;
}>) {
  return (
    <>
      <label>
        Title
        <input
          name="title"
          required
          maxLength={200}
          defaultValue={values.title}
        />
      </label>
      <label>
        Note <small>optional</small>
        <textarea name="note" maxLength={2000} defaultValue={values.note} />
      </label>
      <div className="field-pair">
        <label>
          Account <small>optional</small>
          <select name="accountId" defaultValue={values.accountId}>
            <option value="">None</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Due <small>optional</small>
          <input name="dueOn" type="date" defaultValue={values.dueOn} />
        </label>
      </div>
      <label>
        Link <small>optional: /page or https://…</small>
        <input
          name="link"
          maxLength={2048}
          placeholder="/setup"
          defaultValue={values.link}
        />
      </label>
    </>
  );
}

/**
 * React resets a form's uncontrolled fields after every action, so a failed
 * submission remounts the fields with what the owner typed.
 */
function submittedValues(formData: FormData): TaskFormValues {
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };
  return {
    title: text("title"),
    note: text("note"),
    accountId: text("accountId"),
    link: text("link"),
    dueOn: text("dueOn"),
  };
}

const emptyTask: TaskFormValues = {
  title: "",
  note: "",
  accountId: "",
  link: "",
  dueOn: "",
};

export function AddTaskForm({
  accounts,
}: Readonly<{ accounts: readonly TaskAccountOption[] }>) {
  // Remounting the fields clears them after an add, or keeps them on error.
  const [fields, setFields] = useState({ generation: 0, values: emptyTask });
  const [state, action] = useActionState(
    async (previous: InboxActionState, formData: FormData) => {
      const result = await addTaskAction(previous, formData);
      setFields(({ generation }) => ({
        generation: generation + 1,
        values:
          result.status === "success" ? emptyTask : submittedValues(formData),
      }));
      return result;
    },
    initialState,
  );
  return (
    <form action={action} className="entry-form">
      <div className="form-heading">
        <span>+</span>
        <div>
          <h2>Add a task</h2>
          <p>Your own to-dos, listed with everything the system raises.</p>
        </div>
      </div>
      <TaskFields
        accounts={accounts}
        key={fields.generation}
        values={fields.values}
      />
      <div className="form-footer">
        <FormMessage state={state} />
        <SubmitButton>Add task</SubmitButton>
      </div>
    </form>
  );
}

function SmallForm({
  action,
  children,
  confirmText,
}: Readonly<{
  action: (formData: FormData) => void;
  children: React.ReactNode;
  confirmText?: string;
}>) {
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (confirmText && !window.confirm(confirmText)) event.preventDefault();
      }}
    >
      {children}
    </form>
  );
}

/** Complete or reopen, edit, and delete for an owner task. */
export function TaskActions({
  taskId,
  status,
  accounts,
  values,
}: Readonly<{
  taskId: string;
  status: "open" | "done";
  accounts: readonly TaskAccountOption[];
  values: TaskFormValues;
}>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ generation: 0, values });
  const [editState, edit] = useActionState(
    async (previous: InboxActionState, formData: FormData) => {
      const result = await editTaskAction(previous, formData);
      if (result.status === "success") setEditing(false);
      else {
        setDraft(({ generation }) => ({
          generation: generation + 1,
          values: submittedValues(formData),
        }));
      }
      return result;
    },
    initialState,
  );
  const [toggleState, toggle] = useActionState(
    status === "open" ? completeTaskAction : reopenTaskAction,
    initialState,
  );
  const [deleteState, remove] = useActionState(deleteTaskAction, initialState);
  const message = [deleteState, toggleState, editState].find(
    (state) => state.status === "error",
  );

  return (
    <div className="balance-actions">
      {editing ? (
        <form action={edit} className="inbox-edit">
          <input type="hidden" name="taskId" value={taskId} />
          <TaskFields
            accounts={accounts}
            key={draft.generation}
            values={draft.values}
          />
          <div className="balance-buttons">
            <SubmitButton>Save task</SubmitButton>
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(({ generation }) => ({
                  generation: generation + 1,
                  values,
                }));
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="balance-buttons">
          <SmallForm action={toggle}>
            <input type="hidden" name="taskId" value={taskId} />
            <SubmitButton className={status === "done" ? "secondary" : ""}>
              {status === "open" ? "Done" : "Reopen"}
            </SubmitButton>
          </SmallForm>
          {status === "open" ? (
            <button
              className="secondary"
              type="button"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          ) : null}
          <SmallForm action={remove} confirmText="Delete this task?">
            <input type="hidden" name="taskId" value={taskId} />
            <SubmitButton className="secondary">Delete</SubmitButton>
          </SmallForm>
        </div>
      )}
      {message ? <FormMessage state={message} /> : null}
    </div>
  );
}

/** Snooze for any hideable item; dismiss only where core allows it. */
export function ItemActions({
  itemKey,
  itemVersion,
  canDismiss,
  minDate,
  maxDate,
}: Readonly<{
  itemKey: string;
  itemVersion: string;
  canDismiss: boolean;
  /** Earliest and latest dates a chosen snooze may end. */
  minDate: string;
  maxDate: string;
}>) {
  const [choice, setChoice] = useState("day");
  const [snoozeState, snooze] = useActionState(snoozeItemAction, initialState);
  const [dismissState, dismiss] = useActionState(
    dismissItemAction,
    initialState,
  );
  const message = [dismissState, snoozeState].find(
    (state) => state.status === "error",
  );
  return (
    <div className="balance-actions">
      <div className="balance-buttons">
        <form action={snooze} className="balance-correction">
          <input type="hidden" name="itemKey" value={itemKey} />
          <input type="hidden" name="itemVersion" value={itemVersion} />
          <label>
            Snooze for
            <select
              name="choice"
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
            >
              <option value="day">1 day</option>
              <option value="week">1 week</option>
              <option value="month">1 month</option>
              <option value="date">Until a date</option>
            </select>
          </label>
          {choice === "date" ? (
            <label>
              Until
              <input
                name="until"
                type="date"
                required
                min={minDate}
                max={maxDate}
              />
            </label>
          ) : null}
          <SubmitButton className="secondary">Snooze</SubmitButton>
        </form>
        {canDismiss ? (
          <SmallForm action={dismiss}>
            <input type="hidden" name="itemKey" value={itemKey} />
            <input type="hidden" name="itemVersion" value={itemVersion} />
            <SubmitButton className="secondary">Dismiss</SubmitButton>
          </SmallForm>
        ) : null}
      </div>
      {message ? <FormMessage state={message} /> : null}
    </div>
  );
}

export function RestoreButton({ itemKey }: Readonly<{ itemKey: string }>) {
  const [state, restore] = useActionState(restoreItemAction, initialState);
  return (
    <div className="balance-actions">
      <div className="balance-buttons">
        <SmallForm action={restore}>
          <input type="hidden" name="itemKey" value={itemKey} />
          <SubmitButton className="secondary">Restore</SubmitButton>
        </SmallForm>
      </div>
      {state.status === "error" ? <FormMessage state={state} /> : null}
    </div>
  );
}
