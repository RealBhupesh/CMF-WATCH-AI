// Word boundaries matter: an unbounded "ssn" also matches "businessname".
export const SENSITIVE_FIELD_PATTERN =
  /(password|passcode|social.?security|\bssn\b|credit.?card|card.?number|\bcc[- ]?(number|csc|exp)|\bcvv\b|\bcvc\b|routing.?number|bank.?account|security.?code|\bpin\b|api.?key|access.?token|one.?time.?code|\botp\b|aadhaar|aadhar|passport|government.?id|tax.?id|\bpan\b)/i;

export function isSensitiveField(metadata: string): boolean {
  return SENSITIVE_FIELD_PATTERN.test(metadata.replace(/([a-z])([A-Z])/g, "$1 $2"));
}
