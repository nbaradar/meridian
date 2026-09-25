"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import type { CurrentCategory } from "@/core/ledger";

import {
  createAccountAction,
  createCategoryAction,
  type ManualEntryActionState,
} from "./actions";

const initialState: ManualEntryActionState = { status: "idle", message: "" };

function SubmitButton({ children }: Readonly<{ children: React.ReactNode }>) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Saving..." : children}
    </button>
  );
}

function FormMessage({ state }: Readonly<{ state: ManualEntryActionState }>) {
  if (state.status === "idle") return null;
  return (
    <p className={`form-message ${state.status}`} aria-live="polite">
      {state.message}
    </p>
  );
}

export function AccountForm() {
  const [state, action] = useActionState(createAccountAction, initialState);
  const [accountType, setAccountType] = useState("checking");
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status === "success") {
      formRef.current?.reset();
    }
  }, [state]);

  return (
    <form ref={formRef} action={action} className="entry-form">
      <div className="form-heading">
        <span>01</span>
        <div>
          <h2>Manual account</h2>
          <p>
            Add an offline or import-only account. Connected accounts arrive
            later.
          </p>
        </div>
      </div>
      <label>
        Account name
        <input
          name="name"
          required
          maxLength={120}
          placeholder="Primary checking"
        />
      </label>
      <div className="field-pair">
        <label>
          Account type
          <select
            name="accountType"
            value={accountType}
            onChange={(event) => setAccountType(event.target.value)}
          >
            <option value="checking">Checking</option>
            <option value="savings">Savings</option>
            <option value="credit_card">Credit card</option>
            <option value="loan">Loan</option>
            <option value="mortgage">Mortgage</option>
            <option value="cash">Cash</option>
            <option value="brokerage">Brokerage</option>
            <option value="retirement">Retirement</option>
            <option value="crypto">Crypto</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label>
          Opened on <small>optional</small>
          <input name="openedOn" type="date" />
        </label>
      </div>
      {accountType === "other" ? (
        <label>
          Accounting class
          <select name="accountClass" defaultValue="asset">
            <option value="asset">Asset</option>
            <option value="liability">Liability</option>
          </select>
        </label>
      ) : null}
      <div className="form-footer">
        <FormMessage state={state} />
        <SubmitButton>Create account</SubmitButton>
      </div>
    </form>
  );
}

export function CategoryForm({
  categories,
}: Readonly<{ categories: readonly CurrentCategory[] }>) {
  const [state, action] = useActionState(createCategoryAction, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="entry-form">
      <div className="form-heading">
        <span>02</span>
        <div>
          <h2>New category</h2>
          <p>
            Categories classify journal postings without imposing a budget
            model.
          </p>
        </div>
      </div>
      <label>
        Category name
        <input name="name" required maxLength={120} placeholder="Groceries" />
      </label>
      <div className="field-pair">
        <label>
          Category kind
          <select name="kind" defaultValue="expense">
            <option value="expense">Expense</option>
            <option value="income">Income</option>
            <option value="transfer">Transfer</option>
          </select>
        </label>
        <label>
          Parent <small>optional</small>
          <select name="parentCategoryId" defaultValue="">
            <option value="">No parent</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-footer">
        <FormMessage state={state} />
        <SubmitButton>Create category</SubmitButton>
      </div>
    </form>
  );
}
