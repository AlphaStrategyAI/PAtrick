/** Reported experience description only; host evidence and derived views live separately. */
export interface ExperienceDetails {
  schemaVersion: 1;
  problem: string;
  symptomAliases: string[];
  solution: string;
  files: string[];
  productId: string;
  codeVersion: string;
  environment: string;
  invalidationConditions: string[];
}
