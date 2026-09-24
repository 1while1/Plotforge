class DomainError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function sendDomainError(res, err) {
  if (!(err instanceof DomainError)) return false;
  const error = { code: err.code, message: err.message };
  if (err.details !== undefined) error.details = err.details;
  res.status(err.status).json({ error });
  return true;
}

module.exports = { DomainError, sendDomainError };
