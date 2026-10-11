export function sanitizeOutput(value, sensitiveValues = []) {
  let output = String(value);
  for (const secret of sensitiveValues) {
    if (typeof secret === 'string' && secret.length > 0) output = output.replaceAll(secret, '[REDACTED]');
  }
  return output
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/(authorization\s*:\s*bearer)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*["']?[^"'\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\bPRIVATE_[A-Z0-9_]*CANARY\b/g, '[REDACTED_CANARY]');
}
