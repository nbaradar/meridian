/** Formats a canonical decimal string as USD without converting to a number. */
export function formatUsd(amount: string): string {
  const negative = amount.startsWith("-");
  const [integer = "0", fraction = ""] = amount.replace("-", "").split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `${negative ? "−" : ""}$${grouped}.${fraction.padEnd(2, "0")}`;
}
