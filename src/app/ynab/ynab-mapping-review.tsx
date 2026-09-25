"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useState,
  type FormEvent,
} from "react";

import type { AccountType } from "@/core/ledger";
import type {
  YnabAccountCandidate,
  YnabAccountSaveState,
} from "@/modules/ynab";

import {
  analyzeYnabExportAction,
  saveYnabAccountsAction,
  type YnabAnalysisActionState,
  type YnabExportAnalysis,
  type YnabRenameTarget,
  type YnabSaveActionState,
} from "./actions";

const initialAnalysisState: YnabAnalysisActionState = {
  status: "idle",
  message: "",
  analysis: null,
};

const initialSaveState: YnabSaveActionState = {
  status: "idle",
  message: "",
  results: {},
  review: null,
};

const accountTypes: readonly { value: AccountType; label: string }[] = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "cash", label: "Cash" },
  { value: "credit_card", label: "Credit card" },
  { value: "loan", label: "Loan" },
  { value: "mortgage", label: "Mortgage" },
  { value: "brokerage", label: "Brokerage" },
  { value: "retirement", label: "Retirement" },
  { value: "crypto", label: "Crypto" },
  { value: "other", label: "Other" },
];

type Decision = "" | "create" | "link" | "exclude" | "renamed";

interface RowDraft {
  action: Decision;
  accountId: string;
  accountSourceId: string;
  name: string;
  accountType: string;
  accountClass: string;
  /** An excluded row the person reopened to re-decide. */
  reopened: boolean;
}

function initialDraft(candidate: YnabAccountCandidate): RowDraft {
  return {
    action: "",
    accountId: "",
    accountSourceId: "",
    name: candidate.sourceName,
    accountType: candidate.suggestedType ?? "",
    accountClass: "",
    reopened: false,
  };
}

function typeLabel(accountType: AccountType): string {
  return accountType.replace("_", " ");
}

/** Formats a canonical decimal string for display without converting to a number. */
function formatUsd(amount: string): string {
  const negative = amount.startsWith("-");
  const [integer = "0", fraction = ""] = amount.replace("-", "").split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `${negative ? "−" : ""}$${grouped}.${fraction.padEnd(2, "0")}`;
}

function ActivityEvidence({ candidate }: { candidate: YnabAccountCandidate }) {
  const { activity } = candidate;
  const referenceRows = activity.transferReferences.reduce(
    (sum, reference) => sum + reference.rowCount,
    0,
  );
  return (
    <div className="mapping-evidence">
      <p>
        {activity.registerRowCount === 0
          ? "No register rows (plan category only)"
          : `${activity.registerRowCount.toLocaleString("en-US")} ${activity.registerRowCount === 1 ? "row" : "rows"} · ${activity.firstOccurredOn} → ${activity.lastOccurredOn}`}
        {" · "}
        YNAB balance {formatUsd(activity.workingBalance)}
      </p>
      {activity.transferReferences.length > 0 ? (
        <p>
          Transfers from{" "}
          {activity.transferReferences
            .map(
              (reference) => `${reference.sourceName} (${reference.rowCount})`,
            )
            .join(", ")}
        </p>
      ) : null}
      {activity.sharedSuffixWith.length > 0 ? (
        <p className="mapping-warning">
          Same account-number suffix as {activity.sharedSuffixWith.join(", ")}.
          {activity.workingBalance === "0" && referenceRows === 0
            ? " Its balance is $0.00 and no transfers reference it, so it may be a duplicate YNAB created. Consider excluding it."
            : " Check whether these are the same real account."}
        </p>
      ) : null}
    </div>
  );
}

function SavedSummary({ state }: { state: YnabAccountSaveState }) {
  if (state.status === "tracked") {
    return (
      <p className="mapping-saved">
        {state.account
          ? `Saved → ${state.account.name} · ${typeLabel(state.account.accountType)}`
          : "Saved. Its YNAB source is currently unlinked from any Meridian account."}
      </p>
    );
  }
  return <p className="mapping-saved excluded">Excluded from the migration.</p>;
}

function DecisionFields({
  draft,
  index,
  allowExclude,
  currentAccounts,
  renameTargets,
  update,
}: {
  draft: RowDraft;
  index: number;
  allowExclude: boolean;
  currentAccounts: YnabExportAnalysis["currentAccounts"];
  renameTargets: readonly YnabRenameTarget[];
  update: (change: Partial<RowDraft>) => void;
}) {
  return (
    <div className="mapping-fields">
      <label>
        Decision
        <select
          name={`action-${index}`}
          onChange={(event) =>
            update({ action: event.target.value as Decision })
          }
          value={draft.action}
        >
          <option value="">Choose a decision</option>
          <option value="create">Create account</option>
          <option value="link">Link existing</option>
          {renameTargets.length > 0 ? (
            <option value="renamed">Renamed saved account</option>
          ) : null}
          {allowExclude ? (
            <option value="exclude">Exclude from import</option>
          ) : null}
        </select>
      </label>
      {draft.action === "link" ? (
        <label>
          Existing account
          <select
            name={`accountId-${index}`}
            onChange={(event) => update({ accountId: event.target.value })}
            value={draft.accountId}
          >
            <option value="">
              {currentAccounts.length === 0
                ? "No Meridian accounts exist yet"
                : "Choose an account"}
            </option>
            {currentAccounts.map((account) => (
              <option value={account.id} key={account.id}>
                {account.name} · {typeLabel(account.accountType)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {draft.action === "renamed" ? (
        <label>
          Same YNAB account as
          <select
            name={`accountSourceId-${index}`}
            onChange={(event) =>
              update({ accountSourceId: event.target.value })
            }
            value={draft.accountSourceId}
          >
            <option value="">Choose the saved account</option>
            {renameTargets.map((target) => (
              <option
                value={target.accountSourceId}
                key={target.accountSourceId}
              >
                {target.account.name} · {typeLabel(target.account.accountType)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {draft.action === "create" ? (
        <>
          <label>
            New account name
            <input
              name={`name-${index}`}
              onChange={(event) => update({ name: event.target.value })}
              value={draft.name}
            />
          </label>
          <label>
            New account type
            <select
              name={`accountType-${index}`}
              onChange={(event) => update({ accountType: event.target.value })}
              value={draft.accountType}
            >
              <option value="">Choose a type</option>
              {accountTypes.map((accountType) => (
                <option value={accountType.value} key={accountType.value}>
                  {accountType.label}
                </option>
              ))}
            </select>
          </label>
          {draft.accountType === "other" ? (
            <label>
              Asset or liability
              <select
                name={`accountClass-${index}`}
                onChange={(event) =>
                  update({ accountClass: event.target.value })
                }
                value={draft.accountClass}
              >
                <option value="">Choose a class</option>
                <option value="asset">Asset</option>
                <option value="liability">Liability</option>
              </select>
            </label>
          ) : null}
        </>
      ) : null}
      {draft.action === "exclude" ? (
        <p className="mapping-note">
          This account and its register rows will not be migrated.
        </p>
      ) : null}
    </div>
  );
}

function MappingForm({ analysis }: { analysis: YnabExportAnalysis }) {
  const action = saveYnabAccountsAction.bind(null, analysis.reviewToken);
  const [state, formAction, pending] = useActionState(action, initialSaveState);
  // Controlled drafts, submitted via a manual transition rather than the
  // <form action> prop, so React never resets the person's choices.
  const [drafts, setDrafts] = useState(() =>
    analysis.accountCandidates.map(initialDraft),
  );
  const review = state.review ?? analysis;
  const candidates = analysis.accountCandidates;
  const stateOf = (candidate: YnabAccountCandidate): YnabAccountSaveState =>
    review.saveStates[candidate.sourceName] ?? { status: "unsaved" };
  const savedCount = candidates.filter(
    (candidate) => stateOf(candidate).status !== "unsaved",
  ).length;
  const remainingCount = candidates.filter((candidate, index) => {
    const status = stateOf(candidate).status;
    return (
      (status === "unsaved" && drafts[index]!.action !== "") ||
      (status === "excluded" && drafts[index]!.reopened)
    );
  }).length;
  const firstError = candidates.findIndex(
    (candidate) => state.results[candidate.sourceName]?.status === "error",
  );

  useEffect(() => {
    if (firstError < 0) return;
    document
      .getElementById(`mapping-row-${firstError}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [firstError, state]);

  function update(index: number, change: Partial<RowDraft>) {
    setDrafts((current) =>
      current.map((draft, draftIndex) =>
        draftIndex === index ? { ...draft, ...change } : draft,
      ),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const formData = new FormData(event.currentTarget, submitter);
    startTransition(() => formAction(formData));
  }

  return (
    <form className="mapping-form" onSubmit={submit}>
      <div className="mapping-header">
        <div>
          <p className="eyebrow">Account decisions</p>
          <h2>
            {savedCount} of {candidates.length} accounts saved
          </h2>
        </div>
        <p>
          Save accounts one at a time, or choose decisions and save all
          remaining at once. Saved accounts are recognized the next time you
          import. No transactions or balances are written yet.
        </p>
      </div>

      <div className="mapping-list">
        {candidates.map((candidate, index) => {
          const draft = drafts[index]!;
          const saveState = stateOf(candidate);
          const result = state.results[candidate.sourceName];
          const editable =
            saveState.status === "unsaved" ||
            (saveState.status === "excluded" && draft.reopened);
          const classes = [
            "mapping-row",
            saveState.status !== "unsaved" && !editable ? "saved" : "",
            result?.status === "error" ? "invalid" : "",
            draft.action === "exclude" || saveState.status === "excluded"
              ? "excluded"
              : "",
          ].filter(Boolean);
          return (
            <fieldset
              aria-invalid={result?.status === "error"}
              className={classes.join(" ")}
              id={`mapping-row-${index}`}
              key={candidate.sourceName}
            >
              <legend>{candidate.sourceName}</legend>
              {editable ? (
                <p className="mapping-suggestion">
                  {candidate.suggestedType
                    ? `Suggested: ${typeLabel(candidate.suggestedType)} · ${candidate.suggestionReason}`
                    : "No safe type suggestion. Choose explicitly."}
                </p>
              ) : (
                <SavedSummary state={saveState} />
              )}
              <ActivityEvidence candidate={candidate} />
              {editable ? (
                <DecisionFields
                  allowExclude={saveState.status === "unsaved"}
                  currentAccounts={review.currentAccounts}
                  draft={draft}
                  index={index}
                  renameTargets={review.renameTargets}
                  update={(change) => update(index, change)}
                />
              ) : null}
              <div className="mapping-row-footer">
                {result ? (
                  <p
                    className={`form-message ${result.status === "saved" ? "success" : "error"}`}
                  >
                    {result.message}
                  </p>
                ) : null}
                {editable ? (
                  <button
                    disabled={pending || draft.action === ""}
                    name="intent"
                    type="submit"
                    value={`row-${index}`}
                  >
                    Save
                  </button>
                ) : saveState.status === "excluded" ? (
                  <button
                    className="secondary"
                    disabled={pending}
                    onClick={() => update(index, { reopened: true })}
                    type="button"
                  >
                    Change decision
                  </button>
                ) : null}
              </div>
            </fieldset>
          );
        })}
      </div>

      <div className="mapping-submit">
        {state.status !== "idle" && !pending ? (
          <p className={`form-message ${state.status}`}>{state.message}</p>
        ) : null}
        <button
          disabled={pending || remainingCount === 0}
          name="intent"
          type="submit"
          value="all"
        >
          {pending
            ? "Saving…"
            : `Save all remaining${remainingCount > 0 ? ` (${remainingCount})` : ""}`}
        </button>
      </div>
    </form>
  );
}

export function YnabMappingReview() {
  const [state, formAction, pending] = useActionState(
    analyzeYnabExportAction,
    initialAnalysisState,
  );

  return (
    <>
      <form action={formAction} className="export-form">
        <div>
          <p className="eyebrow">Local analysis</p>
          <h2>Choose both YNAB exports</h2>
          <p>
            Files are parsed in memory for this review and are not persisted by
            this workflow.
          </p>
        </div>
        <label>
          Plan CSV
          <input accept=".csv,text/csv" name="plan" required type="file" />
        </label>
        <label>
          Register CSV
          <input accept=".csv,text/csv" name="register" required type="file" />
        </label>
        <div className="form-footer">
          {state.status !== "idle" ? (
            <p className={`form-message ${state.status}`}>{state.message}</p>
          ) : null}
          <button disabled={pending} type="submit">
            {pending ? "Analyzing…" : "Analyze export"}
          </button>
        </div>
      </form>

      {state.analysis ? (
        <>
          <dl className="analysis-summary">
            <div>
              <dt>Plan rows</dt>
              <dd>{state.analysis.planRowCount}</dd>
            </div>
            <div>
              <dt>Register rows</dt>
              <dd>{state.analysis.registerRowCount}</dd>
            </div>
            <div>
              <dt>Categories</dt>
              <dd>{state.analysis.categoryCount}</dd>
            </div>
            <div>
              <dt>Transactions</dt>
              <dd>{state.analysis.transactionCount}</dd>
            </div>
            <div>
              <dt>Ignored rows</dt>
              <dd>{state.analysis.ignoredRecordCount}</dd>
            </div>
          </dl>
          <MappingForm
            analysis={state.analysis}
            key={state.analysis.reviewToken}
          />
        </>
      ) : null}
    </>
  );
}
