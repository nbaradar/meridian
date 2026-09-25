"use client";

import { useActionState, useState, useSyncExternalStore } from "react";
import { useFormStatus } from "react-dom";

import type { AccountClass } from "@/core/ledger";

import {
  correctBalanceAction,
  recordBalanceAction,
  retractBalanceAction,
  type BalanceActionState,
} from "./actions";

const initialState: BalanceActionState = { status: "idle", message: "" };

export interface BalanceAccountOption {
  id: string;
  name: string;
  accountClass: AccountClass;
}

const noSubscription = () => () => undefined;

/** The browser's local calendar date, as YYYY-MM-DD. */
function localToday(): string {
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function amountLabel(accountClass: AccountClass | undefined): string {
  return accountClass === "liability" ? "Amount owed" : "Balance";
}

function SubmitButton({ children }: Readonly<{ children: React.ReactNode }>) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Saving..." : children}
    </button>
  );
}

function FormMessage({ state }: Readonly<{ state: BalanceActionState }>) {
  if (state.status === "idle") return null;
  return (
    <p className={`form-message ${state.status}`} aria-live="polite">
      {state.message}
    </p>
  );
}

export function RecordBalanceForm({
  accounts,
  latestAllowedDate,
}: Readonly<{
  accounts: readonly BalanceAccountOption[];
  latestAllowedDate: string;
}>) {
  const [accountId, setAccountId] = useState("");
  const [enteredAmount, setEnteredAmount] = useState("");
  // Defaults to the browser's local today; the server has no local date.
  const today = useSyncExternalStore(noSubscription, localToday, () => "");
  const [chosenDate, setChosenDate] = useState<string | null>(null);
  const [state, action] = useActionState(
    async (previous: BalanceActionState, formData: FormData) => {
      const result = await recordBalanceAction(previous, formData);
      if (result.status === "success") setEnteredAmount("");
      return result;
    },
    initialState,
  );
  const accountClass = accounts.find(
    (account) => account.id === accountId,
  )?.accountClass;

  return (
    <form action={action} className="entry-form balance-entry">
      <div className="form-heading">
        <span>+</span>
        <div>
          <h2>Record a balance</h2>
          <p>
            For a liability, enter what you owe; enter a credit as a negative
            amount owed.
          </p>
        </div>
      </div>
      <label>
        Account
        <select
          name="accountId"
          required
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
        >
          <option value="">
            {accounts.length === 0 ? "Create an account first" : "Choose"}
          </option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </label>
      <div className="field-pair">
        <label>
          {amountLabel(accountClass)}
          <input
            name="enteredAmount"
            required
            inputMode="decimal"
            placeholder="1234.56"
            value={enteredAmount}
            onChange={(event) => setEnteredAmount(event.target.value)}
          />
        </label>
        <label>
          As of
          <input
            name="observedOn"
            type="date"
            required
            max={latestAllowedDate}
            value={chosenDate ?? today}
            onChange={(event) => setChosenDate(event.target.value)}
          />
        </label>
      </div>
      <div className="form-footer">
        <FormMessage state={state} />
        <SubmitButton>Record balance</SubmitButton>
      </div>
    </form>
  );
}

/** "Correct" and "Retract" for an account's current balance. */
export function CurrentBalanceActions({
  observationId,
  accountId,
  accountClass,
  entryAmount,
  observedOn,
  latestAllowedDate,
}: Readonly<{
  observationId: string;
  accountId: string;
  accountClass: AccountClass;
  /** The current amount as the owner would type it (amount owed for debt). */
  entryAmount: string;
  observedOn: string;
  latestAllowedDate: string;
}>) {
  const [correcting, setCorrecting] = useState(false);
  const [correctState, correct] = useActionState(
    async (previous: BalanceActionState, formData: FormData) => {
      const result = await correctBalanceAction(previous, formData);
      if (result.status === "success") setCorrecting(false);
      return result;
    },
    initialState,
  );
  const [retractState, retract] = useActionState(
    retractBalanceAction,
    initialState,
  );

  const message = retractState.status === "error" ? retractState : correctState;

  return (
    <div className="balance-actions">
      {correcting ? (
        <form action={correct} className="balance-correction">
          <input type="hidden" name="accountId" value={accountId} />
          <input
            type="hidden"
            name="supersedesObservationId"
            value={observationId}
          />
          <label>
            {amountLabel(accountClass)}
            <input
              name="enteredAmount"
              required
              inputMode="decimal"
              defaultValue={entryAmount}
            />
          </label>
          <label>
            As of
            <input
              name="observedOn"
              type="date"
              required
              max={latestAllowedDate}
              defaultValue={observedOn}
            />
          </label>
          <SubmitButton>Save correction</SubmitButton>
          <button
            className="secondary"
            type="button"
            onClick={() => setCorrecting(false)}
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="balance-buttons">
          <button
            className="secondary"
            type="button"
            onClick={() => setCorrecting(true)}
          >
            Correct
          </button>
          <form
            action={retract}
            onSubmit={(event) => {
              if (
                !window.confirm(
                  "Retract this balance? The account will show its previous balance, or none.",
                )
              ) {
                event.preventDefault();
              }
            }}
          >
            <input type="hidden" name="observationId" value={observationId} />
            <button className="secondary" type="submit">
              Retract
            </button>
          </form>
        </div>
      )}
      {message.status === "error" ? <FormMessage state={message} /> : null}
    </div>
  );
}
