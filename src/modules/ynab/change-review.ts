import type { YnabRegisterRow } from "./csv";

export type YnabChangedField =
  | "account"
  | "occurred_on"
  | "amount"
  | "payee"
  | "category"
  | "memo"
  | "cleared"
  | "flag";

export interface YnabRowMatch {
  previousIndex: number;
  currentIndex: number;
}

export interface YnabRevisionSuggestion extends YnabRowMatch {
  changedFields: readonly YnabChangedField[];
  suggestedAction: "correct_and_replace";
}

export interface YnabPossibleMatch extends YnabRowMatch {
  changedFields: readonly YnabChangedField[];
}

export interface YnabRegisterChangeReview {
  previousRowCount: number;
  currentRowCount: number;
  exactMatches: readonly YnabRowMatch[];
  suggestedRevisions: readonly YnabRevisionSuggestion[];
  possibleMatches: readonly YnabPossibleMatch[];
  suggestedAdditions: readonly number[];
  suggestedRemovals: readonly number[];
}

export type YnabChangeDecision =
  | ({ action: "correct_and_replace" } & YnabRowMatch)
  | { action: "add"; currentIndex: number }
  | { action: "remove"; previousIndex: number };

function rowContent(row: YnabRegisterRow): string {
  return JSON.stringify([
    row.account,
    row.flag,
    row.occurredOn,
    row.payee,
    row.categoryGroupAndCategory,
    row.categoryGroup,
    row.category,
    row.memo,
    row.outflow,
    row.inflow,
    row.cleared,
  ]);
}

function changedFields(
  previous: YnabRegisterRow,
  current: YnabRegisterRow,
): YnabChangedField[] {
  const changed: YnabChangedField[] = [];
  if (previous.account !== current.account) changed.push("account");
  if (previous.occurredOn !== current.occurredOn) changed.push("occurred_on");
  if (
    previous.outflow !== current.outflow ||
    previous.inflow !== current.inflow
  ) {
    changed.push("amount");
  }
  if (previous.payee !== current.payee) changed.push("payee");
  if (
    previous.categoryGroupAndCategory !== current.categoryGroupAndCategory ||
    previous.categoryGroup !== current.categoryGroup ||
    previous.category !== current.category
  ) {
    changed.push("category");
  }
  if (previous.memo !== current.memo) changed.push("memo");
  if (previous.cleared !== current.cleared) changed.push("cleared");
  if (previous.flag !== current.flag) changed.push("flag");
  return changed;
}

function isPlausibleRevision(fields: readonly YnabChangedField[]): boolean {
  const identityChanges = fields.filter(
    (field) =>
      field === "account" || field === "occurred_on" || field === "amount",
  );
  return (
    fields.length > 0 &&
    (identityChanges.length === 0 ||
      (identityChanges.length === 1 && fields.length === 1))
  );
}

export function reviewYnabRegisterChanges(
  previousRows: readonly YnabRegisterRow[],
  currentRows: readonly YnabRegisterRow[],
): YnabRegisterChangeReview {
  const currentByContent = new Map<
    string,
    { indexes: number[]; next: number }
  >();
  currentRows.forEach((row, index) => {
    const content = rowContent(row);
    const matches = currentByContent.get(content);
    if (matches) matches.indexes.push(index);
    else currentByContent.set(content, { indexes: [index], next: 0 });
  });

  const exactMatches: YnabRowMatch[] = [];
  const matchedPrevious = new Set<number>();
  const matchedCurrent = new Set<number>();
  previousRows.forEach((row, previousIndex) => {
    const matches = currentByContent.get(rowContent(row));
    if (!matches || matches.next >= matches.indexes.length) return;
    const currentIndex = matches.indexes[matches.next]!;
    matches.next += 1;
    exactMatches.push({ previousIndex, currentIndex });
    matchedPrevious.add(previousIndex);
    matchedCurrent.add(currentIndex);
  });

  const possible: YnabPossibleMatch[] = [];
  const previousCandidateCounts = new Map<number, number>();
  const currentCandidateCounts = new Map<number, number>();
  previousRows.forEach((previous, previousIndex) => {
    if (matchedPrevious.has(previousIndex)) return;
    currentRows.forEach((current, currentIndex) => {
      if (matchedCurrent.has(currentIndex)) return;
      const fields = changedFields(previous, current);
      if (!isPlausibleRevision(fields)) return;
      possible.push({ previousIndex, currentIndex, changedFields: fields });
      previousCandidateCounts.set(
        previousIndex,
        (previousCandidateCounts.get(previousIndex) ?? 0) + 1,
      );
      currentCandidateCounts.set(
        currentIndex,
        (currentCandidateCounts.get(currentIndex) ?? 0) + 1,
      );
    });
  });

  const suggestedRevisions: YnabRevisionSuggestion[] = [];
  const possibleMatches: YnabPossibleMatch[] = [];
  for (const match of possible) {
    if (
      previousCandidateCounts.get(match.previousIndex) === 1 &&
      currentCandidateCounts.get(match.currentIndex) === 1
    ) {
      suggestedRevisions.push({
        ...match,
        suggestedAction: "correct_and_replace",
      });
    } else {
      possibleMatches.push(match);
    }
  }

  const suggestedRemovals = previousRows.flatMap((_, index) =>
    matchedPrevious.has(index) || previousCandidateCounts.has(index)
      ? []
      : [index],
  );
  const suggestedAdditions = currentRows.flatMap((_, index) =>
    matchedCurrent.has(index) || currentCandidateCounts.has(index)
      ? []
      : [index],
  );

  return {
    previousRowCount: previousRows.length,
    currentRowCount: currentRows.length,
    exactMatches,
    suggestedRevisions,
    possibleMatches,
    suggestedAdditions,
    suggestedRemovals,
  };
}

export function finalizeYnabChangeReview(
  review: YnabRegisterChangeReview,
  decisions: readonly YnabChangeDecision[],
): readonly YnabChangeDecision[] {
  const resolvedPrevious = new Set(
    review.exactMatches.map((match) => match.previousIndex),
  );
  const resolvedCurrent = new Set(
    review.exactMatches.map((match) => match.currentIndex),
  );

  const claim = (
    indexes: Set<number>,
    index: number,
    count: number,
    side: "previous" | "current",
  ) => {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new Error(`YNAB ${side} row index is out of range: ${index}`);
    }
    if (indexes.has(index)) {
      throw new Error(`YNAB ${side} row is resolved more than once: ${index}`);
    }
    indexes.add(index);
  };

  for (const decision of decisions) {
    if (decision.action === "correct_and_replace") {
      claim(
        resolvedPrevious,
        decision.previousIndex,
        review.previousRowCount,
        "previous",
      );
      claim(
        resolvedCurrent,
        decision.currentIndex,
        review.currentRowCount,
        "current",
      );
    } else if (decision.action === "add") {
      claim(
        resolvedCurrent,
        decision.currentIndex,
        review.currentRowCount,
        "current",
      );
    } else {
      claim(
        resolvedPrevious,
        decision.previousIndex,
        review.previousRowCount,
        "previous",
      );
    }
  }

  if (
    resolvedPrevious.size !== review.previousRowCount ||
    resolvedCurrent.size !== review.currentRowCount
  ) {
    throw new Error("Every changed YNAB row requires an explicit decision");
  }
  return [...decisions];
}
